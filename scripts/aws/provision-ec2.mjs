#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RunInstancesCommand,
  waitUntilInstanceRunning,
} from '@aws-sdk/client-ec2';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const DEFAULT_AMI_PARAMETER = '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64';
const DEFAULT_INSTANCE_TYPE = 't3.micro';
const DEFAULT_APP_PORT = 3000;
const DEFAULT_ROOT_VOLUME_GB = 16;
const DEFAULT_SECURITY_GROUP_NAME = 'grad-planner-agent-sg';
const DEFAULT_INSTANCE_NAME_PREFIX = 'grad-planner-agent';

const usage = `
Usage:
  pnpm run aws:provision:ec2
  pnpm run aws:provision:ec2 -- --dry-run

Required environment variables:
  AWS_REGION (or AWS_DEFAULT_REGION)
  EC2_KEY_NAME

Optional environment variables:
  EC2_INSTANCE_TYPE            default: t3.micro
  EC2_INSTANCE_NAME            default: grad-planner-agent-YYYYMMDD
  EC2_ROOT_VOLUME_GB           default: 16
  EC2_AMI_ID                   default: latest Amazon Linux 2023 via SSM
  EC2_VPC_ID                   default: account default VPC
  EC2_SUBNET_ID                default: first available subnet in VPC
  EC2_SECURITY_GROUP_ID        default: create/use EC2_SECURITY_GROUP_NAME
  EC2_SECURITY_GROUP_NAME      default: grad-planner-agent-sg
  EC2_SSH_CIDR                 default: 0.0.0.0/0
  EC2_APP_CIDR                 default: 0.0.0.0/0
  EC2_APP_PORT                 default: 3000
  EC2_IAM_INSTANCE_PROFILE     optional instance profile name

  APP_REPO_URL                 default: git remote.origin.url
  APP_REPO_REF                 default: current branch
  APP_ENV_B64                  base64 content for instance .env
  APP_ENV_FILE                 local path to .env file (auto-base64 encoded)
  APP_SKIP_BUILD               default: false
`;

const parseArgs = () => {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(usage.trim());
    process.exit(0);
  }

  return {
    dryRun: args.has('--dry-run'),
  };
};

const getRequiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const getRegion = () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;

const toPositiveInt = (value, fallback, name) => {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${value}`);
  }
  return parsed;
};

const toBoolean = (value, fallback) => {
  if (value == null || value === '') return fallback;
  return value.toLowerCase() === 'true';
};

const safeGitRead = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const buildInstanceName = () => {
  const explicit = process.env.EC2_INSTANCE_NAME;
  if (explicit) return explicit;

  const date = new Date();
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${date.getUTCDate()}`.padStart(2, '0');
  return `${DEFAULT_INSTANCE_NAME_PREFIX}-${y}${m}${d}`;
};

const loadAppEnvB64 = () => {
  if (process.env.APP_ENV_B64) return process.env.APP_ENV_B64.trim();
  const file = process.env.APP_ENV_FILE;
  if (!file) return '';
  const raw = readFileSync(file, 'utf8');
  return Buffer.from(raw, 'utf8').toString('base64');
};

const buildUserData = ({
  appPort,
  appRepoUrl,
  appRepoRef,
  appEnvB64,
  appSkipBuild,
}) => {
  const repoUrlB64 = Buffer.from(appRepoUrl || '', 'utf8').toString('base64');
  const repoRefB64 = Buffer.from(appRepoRef || '', 'utf8').toString('base64');

  return `#!/bin/bash
set -euxo pipefail

APP_DIR="/opt/grad-planner-agent"
APP_PORT="${appPort}"
REPO_URL_B64='${repoUrlB64}'
REPO_REF_B64='${repoRefB64}'
APP_ENV_B64='${appEnvB64 || ''}'
SKIP_BUILD='${appSkipBuild ? 'true' : 'false'}'

run_as_ec2() {
  su - ec2-user -c "$1"
}

dnf update -y
dnf install -y git

run_as_ec2 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash'
run_as_ec2 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 20; nvm alias default 20'

mkdir -p "$APP_DIR"

if [ -n "$REPO_URL_B64" ]; then
  REPO_URL="$(echo "$REPO_URL_B64" | base64 --decode)"
  if [ ! -d "$APP_DIR/.git" ]; then
    git clone "$REPO_URL" "$APP_DIR"
  fi
  chown -R ec2-user:ec2-user "$APP_DIR"

  if [ -n "$REPO_REF_B64" ]; then
    REPO_REF="$(echo "$REPO_REF_B64" | base64 --decode)"
    run_as_ec2 "cd '$APP_DIR' && git fetch --all --tags && git checkout \\"$REPO_REF\\""
  fi

  run_as_ec2 "export NVM_DIR=\\"\\$HOME/.nvm\\"; . \\"\\$NVM_DIR/nvm.sh\\"; cd '$APP_DIR' && npm ci"

  if [ "$SKIP_BUILD" != "true" ]; then
    run_as_ec2 "export NVM_DIR=\\"\\$HOME/.nvm\\"; . \\"\\$NVM_DIR/nvm.sh\\"; cd '$APP_DIR' && npm run build"
  fi

  if [ -n "$APP_ENV_B64" ]; then
    echo "$APP_ENV_B64" | base64 --decode > "$APP_DIR/.env"
    chown ec2-user:ec2-user "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
  fi

  cat >/usr/local/bin/grad-planner-start.sh <<EOF
#!/bin/bash
set -euo pipefail
export NVM_DIR="/home/ec2-user/.nvm"
. "\\$NVM_DIR/nvm.sh"
cd "$APP_DIR"
if [ "$SKIP_BUILD" = "true" ]; then
  exec npm run dev -- --hostname 0.0.0.0 --port "$APP_PORT"
fi
exec npm run start -- --hostname 0.0.0.0 --port "$APP_PORT"
EOF
  chmod +x /usr/local/bin/grad-planner-start.sh

  cat >/etc/systemd/system/grad-planner-agent.service <<EOF
[Unit]
Description=Grad Planner Agent
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=$APP_DIR
ExecStart=/usr/local/bin/grad-planner-start.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now grad-planner-agent.service
fi
`;
};

const resolveDefaultVpcId = async (ec2, configuredVpcId) => {
  if (configuredVpcId) return configuredVpcId;

  const response = await ec2.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: 'is-default', Values: ['true'] }],
    }),
  );
  const vpcId = response.Vpcs?.[0]?.VpcId;
  if (!vpcId) {
    throw new Error('No default VPC found. Set EC2_VPC_ID explicitly.');
  }
  return vpcId;
};

const resolveSubnetId = async (ec2, vpcId, configuredSubnetId) => {
  if (configuredSubnetId) return configuredSubnetId;

  const response = await ec2.send(
    new DescribeSubnetsCommand({
      Filters: [
        { Name: 'vpc-id', Values: [vpcId] },
        { Name: 'state', Values: ['available'] },
      ],
    }),
  );

  const subnetId = response.Subnets?.sort((a, b) => (a.AvailabilityZone || '').localeCompare(b.AvailabilityZone || ''))[0]?.SubnetId;
  if (!subnetId) {
    throw new Error(`No available subnet found for VPC ${vpcId}. Set EC2_SUBNET_ID explicitly.`);
  }
  return subnetId;
};

const resolveAmiId = async (ssm, configuredAmiId) => {
  if (configuredAmiId) return configuredAmiId;

  const response = await ssm.send(
    new GetParameterCommand({
      Name: DEFAULT_AMI_PARAMETER,
    }),
  );
  const amiId = response.Parameter?.Value;
  if (!amiId) {
    throw new Error(`Unable to resolve AMI from SSM parameter ${DEFAULT_AMI_PARAMETER}. Set EC2_AMI_ID explicitly.`);
  }
  return amiId;
};

const ensureIngressRule = async (ec2, securityGroupId, port, cidr, description) => {
  try {
    await ec2.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: [
          {
            FromPort: port,
            ToPort: port,
            IpProtocol: 'tcp',
            IpRanges: [{ CidrIp: cidr, Description: description }],
          },
        ],
      }),
    );
  } catch (error) {
    if (error?.name === 'InvalidPermission.Duplicate') return;
    throw error;
  }
};

const resolveSecurityGroupId = async ({
  ec2,
  vpcId,
  configuredSecurityGroupId,
  securityGroupName,
  sshCidr,
  appCidr,
  appPort,
}) => {
  if (configuredSecurityGroupId) {
    await ensureIngressRule(ec2, configuredSecurityGroupId, 22, sshCidr, 'SSH');
    await ensureIngressRule(ec2, configuredSecurityGroupId, appPort, appCidr, 'Grad Planner App');
    return configuredSecurityGroupId;
  }

  const describeResponse = await ec2.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [securityGroupName] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    }),
  );

  let securityGroupId = describeResponse.SecurityGroups?.[0]?.GroupId;
  if (!securityGroupId) {
    const createResponse = await ec2.send(
      new CreateSecurityGroupCommand({
        GroupName: securityGroupName,
        Description: 'Security group for grad-planner-agent',
        VpcId: vpcId,
      }),
    );
    securityGroupId = createResponse.GroupId;
  }

  if (!securityGroupId) {
    throw new Error('Failed to resolve or create security group.');
  }

  await ensureIngressRule(ec2, securityGroupId, 22, sshCidr, 'SSH');
  await ensureIngressRule(ec2, securityGroupId, appPort, appCidr, 'Grad Planner App');

  return securityGroupId;
};

const main = async () => {
  const { dryRun } = parseArgs();

  const region = getRegion();
  if (!region) {
    throw new Error('AWS_REGION (or AWS_DEFAULT_REGION) is required.');
  }

  const config = {
    region,
    keyName: getRequiredEnv('EC2_KEY_NAME'),
    instanceType: process.env.EC2_INSTANCE_TYPE || DEFAULT_INSTANCE_TYPE,
    instanceName: buildInstanceName(),
    rootVolumeGb: toPositiveInt(process.env.EC2_ROOT_VOLUME_GB, DEFAULT_ROOT_VOLUME_GB, 'EC2_ROOT_VOLUME_GB'),
    sshCidr: process.env.EC2_SSH_CIDR || '0.0.0.0/0',
    appCidr: process.env.EC2_APP_CIDR || '0.0.0.0/0',
    appPort: toPositiveInt(process.env.EC2_APP_PORT, DEFAULT_APP_PORT, 'EC2_APP_PORT'),
    vpcId: process.env.EC2_VPC_ID || '',
    subnetId: process.env.EC2_SUBNET_ID || '',
    amiId: process.env.EC2_AMI_ID || '',
    securityGroupId: process.env.EC2_SECURITY_GROUP_ID || '',
    securityGroupName: process.env.EC2_SECURITY_GROUP_NAME || DEFAULT_SECURITY_GROUP_NAME,
    iamInstanceProfileName: process.env.EC2_IAM_INSTANCE_PROFILE || '',
    appRepoUrl: process.env.APP_REPO_URL || safeGitRead('git config --get remote.origin.url'),
    appRepoRef: process.env.APP_REPO_REF || safeGitRead('git rev-parse --abbrev-ref HEAD'),
    appEnvB64: loadAppEnvB64(),
    appSkipBuild: toBoolean(process.env.APP_SKIP_BUILD, false),
  };

  const userDataScript = buildUserData(config);
  const userDataBytes = Buffer.byteLength(userDataScript, 'utf8');
  if (userDataBytes > 16 * 1024) {
    throw new Error(`User data is too large (${userDataBytes} bytes). Keep it under 16384 bytes.`);
  }

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ...config,
          appEnvB64: config.appEnvB64 ? '[provided]' : '',
          userDataLength: userDataScript.length,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (config.sshCidr === '0.0.0.0/0') {
    console.warn('Warning: EC2_SSH_CIDR is 0.0.0.0/0 (SSH open to the world).');
  }
  if (config.appCidr === '0.0.0.0/0') {
    console.warn('Warning: EC2_APP_CIDR is 0.0.0.0/0 (app port open to the world).');
  }
  if (!config.appRepoUrl) {
    console.warn('Warning: APP_REPO_URL is empty. Instance will be provisioned without cloning the app.');
  }

  const ec2 = new EC2Client({ region: config.region });
  const ssm = new SSMClient({ region: config.region });

  const vpcId = await resolveDefaultVpcId(ec2, config.vpcId);
  const subnetId = await resolveSubnetId(ec2, vpcId, config.subnetId);
  const amiId = await resolveAmiId(ssm, config.amiId);
  const securityGroupId = await resolveSecurityGroupId({
    ec2,
    vpcId,
    configuredSecurityGroupId: config.securityGroupId,
    securityGroupName: config.securityGroupName,
    sshCidr: config.sshCidr,
    appCidr: config.appCidr,
    appPort: config.appPort,
  });

  const runResponse = await ec2.send(
    new RunInstancesCommand({
      ImageId: amiId,
      InstanceType: config.instanceType,
      KeyName: config.keyName,
      MinCount: 1,
      MaxCount: 1,
      NetworkInterfaces: [
        {
          DeviceIndex: 0,
          SubnetId: subnetId,
          Groups: [securityGroupId],
          AssociatePublicIpAddress: true,
        },
      ],
      IamInstanceProfile: config.iamInstanceProfileName ? { Name: config.iamInstanceProfileName } : undefined,
      UserData: Buffer.from(userDataScript, 'utf8').toString('base64'),
      BlockDeviceMappings: [
        {
          DeviceName: '/dev/xvda',
          Ebs: {
            VolumeSize: config.rootVolumeGb,
            VolumeType: 'gp3',
            DeleteOnTermination: true,
          },
        },
      ],
      MetadataOptions: {
        HttpTokens: 'required',
      },
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Name', Value: config.instanceName },
            { Key: 'Project', Value: 'grad-planner-agent' },
          ],
        },
        {
          ResourceType: 'volume',
          Tags: [
            { Key: 'Name', Value: `${config.instanceName}-root` },
            { Key: 'Project', Value: 'grad-planner-agent' },
          ],
        },
      ],
    }),
  );

  const instanceId = runResponse.Instances?.[0]?.InstanceId;
  if (!instanceId) {
    throw new Error('EC2 did not return an instance id.');
  }

  await waitUntilInstanceRunning(
    { client: ec2, maxWaitTime: 300 },
    {
      InstanceIds: [instanceId],
    },
  );

  const describeResponse = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  const instance = describeResponse.Reservations?.[0]?.Instances?.[0];

  const summary = {
    region: config.region,
    instanceId,
    instanceType: config.instanceType,
    state: instance?.State?.Name || 'unknown',
    amiId,
    keyName: config.keyName,
    vpcId,
    subnetId,
    securityGroupId,
    publicDnsName: instance?.PublicDnsName || '',
    publicIpAddress: instance?.PublicIpAddress || '',
    appUrl: instance?.PublicDnsName ? `http://${instance.PublicDnsName}:${config.appPort}` : '',
  };

  console.log(JSON.stringify(summary, null, 2));

  if (summary.publicDnsName) {
    console.log(`\nSSH: ssh -i /path/to/${config.keyName}.pem ec2-user@${summary.publicDnsName}`);
    console.log(`App: ${summary.appUrl}`);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
