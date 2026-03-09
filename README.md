# grad-planner-agent

Agentic graduation planner application.

## Local Development

```bash
pnpm i
pnpm run dev
```

## AWS EC2 (SDK Provisioning)

This repo includes an AWS SDK script to launch a basic EC2 host (`t3.micro`) and optionally bootstrap this app.

```bash
pnpm run aws:provision:ec2
```

Minimum required environment variables:

- `AWS_REGION` (or `AWS_DEFAULT_REGION`)
- `EC2_KEY_NAME`

Common optional environment variables:

- `EC2_INSTANCE_TYPE` (default `t3.micro`)
- `EC2_SSH_CIDR` (default `0.0.0.0/0`)
- `EC2_APP_PORT` (default `3000`)
- `EC2_APP_CIDR` (default `0.0.0.0/0`)
- `APP_REPO_URL` (defaults to local `git remote.origin.url`)
- `APP_REPO_REF` (defaults to local branch)
- `APP_ENV_FILE` (path to local `.env`, auto base64-encoded into instance user-data)
- `APP_ENV_B64` (base64 of `.env`, if you prefer to provide it directly)
- `APP_SKIP_BUILD` (`true` skips `npm run build` and runs `npm run dev`)

Example:

```bash
export AWS_REGION=us-west-2
export EC2_KEY_NAME=my-ec2-key
export EC2_SSH_CIDR=203.0.113.10/32
export APP_ENV_FILE=.env
pnpm run aws:provision:ec2
```

Dry run (prints resolved config without creating resources):

```bash
pnpm run aws:provision:ec2 -- --dry-run
```

## Environment Variables

Required for core app:

- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Required for cross-app authentication and persistence:

- `GRAD_PLANNER_HANDOFF_SECRET`
- `AGENT_SESSION_SECRET`
- `AGENT_SESSION_IDLE_TTL_SECONDS` (default: `900` / 15 minutes)
- `AGENT_SESSION_ABSOLUTE_TTL_SECONDS` (default: `5400` / 90 minutes)
- `AGENT_RELAUNCH_URL` (default: `https://app.stuplanning.com/grad-plan`; should be a browser-friendly URL)
- `GRAD_PLANNER_HANDOFF_ISSUER` (default: `stuplanning-app`)
- `GRAD_PLANNER_HANDOFF_AUDIENCE` (default: `grad-planner-agent`)
- `SUPABASE_SERVICE_ROLE_KEY`

Optional telemetry (PostHog):

- `POSTHOG_HOST` (or `NEXT_PUBLIC_POSTHOG_HOST`)
- `POSTHOG_KEY` / `POSTHOG_API_KEY` (or `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_API_KEY`)
- Telemetry is sent only when `NODE_ENV=production` and the request host is not localhost/127.0.0.1.

Optional persistence config:

- `AGENT_HANDOFFS_TABLE` (default: `agent_handoffs`)
- `GRAD_PLAN_TABLE` (default: `grad_plan`)
- `GRAD_PLAN_ID_COLUMN` (default: `id`)
- `GRAD_PLAN_USER_COLUMN` (optional override; if omitted, app auto-detects ownership column in this order: `profile_id`, `student_id`, `user_id`)
- `GRAD_PLAN_JSON_COLUMN` (default: `plan_details`)
- `GRAD_PLAN_ACTIVE_COLUMN` (default: `is_active`)
- `GRAD_PLAN_NAME_COLUMN` (default: `plan_name`)
- `GRAD_PLAN_UPDATED_AT_COLUMN` (default: `updated_at`)
- `GRAD_PLAN_PROGRAMS_COLUMN` (default: `programs_in_plan`)
- `GRAD_PLAN_ACTIVE_RPC` (optional; when set, finalize will call RPC before fallback row insert)
- `GRAD_PLAN_ACTIVE_RPC_STUDENT_PARAM` (default: `p_student_id`)
- `GRAD_PLAN_ACTIVE_RPC_PLAN_PARAM` (default: `p_plan_details`)
- `GRAD_PLAN_ACTIVE_RPC_PLAN_NAME_PARAM` (default: `p_plan_name`)
- `GRAD_PLAN_ACTIVE_RPC_PROGRAMS_PARAM` (optional RPC arg name for program id array)
- `GRAD_PLAN_RETURN_URL` (default: `https://app.stuplanning.com/grad-plan`)
- `AGENT_PROFILES_TABLE` (default: `profiles`)
- `AGENT_PROFILES_AUTH_USER_COLUMN` (default: `user_id`)
- `AGENT_PROFILES_ID_COLUMN` (default: `id`)
- `AGENT_PROFILES_STUDENT_ID_COLUMN` (optional fallback for schemas storing student id on profile rows)
- `AGENT_STUDENT_TABLE` (default: `student`)
- `AGENT_STUDENT_ID_COLUMN` (default: `id`)
- `AGENT_STUDENT_AUTH_USER_COLUMN` (default: `user_id`; primary mapping from auth user -> student)
- `AGENT_STUDENT_PROFILE_COLUMN` (optional fallback for schemas mapping student -> profile id)
- `AGENT_USER_COURSES_TABLE` (default: `user_courses`)
- `AGENT_USER_COURSES_USER_COLUMN` (default: `user_id`)
- `AGENT_USER_COURSES_COURSES_COLUMN` (default: `courses`)

## New Auth Routes

- `GET /auth/handoff` consumes one-time handoff token and issues `agent_session` cookie.
- `GET /api/session/bootstrap` returns authenticated bootstrap context.
- `GET /api/session/transcript-context` checks existing transcript courses for the authenticated user profile.
- `POST /api/plan/finalize` validates plan heuristics, persists active plan, returns redirect URL.
  - Request body: `{ planId: string, planName?: string }`

## Stuplanning Integration

See [`docs/stuplanning-agent-handoff-integration.md`](/Users/vinjones/grad-planner-agent/docs/stuplanning-agent-handoff-integration.md).
