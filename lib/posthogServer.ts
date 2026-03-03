type TelemetryLevel = 'info' | 'warn' | 'error';

type CaptureContext = {
  route?: string;
  request?: Request;
  distinctId?: string | null;
  properties?: Record<string, unknown>;
};

const LOCAL_HOST_PATTERNS = ['localhost', '127.0.0.1', '::1'];

const resolvePosthogHost = (): string => {
  const raw =
    process.env.POSTHOG_HOST ||
    process.env.NEXT_PUBLIC_POSTHOG_HOST ||
    '';
  return raw.replace(/\/+$/, '');
};

const resolvePosthogKey = (): string =>
  process.env.POSTHOG_KEY ||
  process.env.POSTHOG_API_KEY ||
  process.env.NEXT_PUBLIC_POSTHOG_KEY ||
  process.env.NEXT_PUBLIC_POSTHOG_API_KEY ||
  '';

const getRequestHost = (request?: Request): string => {
  if (!request) return '';
  try {
    const url = new URL(request.url);
    if (url.hostname) return url.hostname.toLowerCase();
  } catch {
    // Ignore parse issues and try header fallback.
  }

  const headerHost = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  return headerHost.toLowerCase();
};

const isLocalHost = (host: string): boolean =>
  LOCAL_HOST_PATTERNS.some((pattern) => host.includes(pattern));

const isTelemetryEnabled = (request?: Request): boolean => {
  if (process.env.NODE_ENV !== 'production') return false;
  if (!resolvePosthogHost() || !resolvePosthogKey()) return false;

  const host = getRequestHost(request);
  if (host && isLocalHost(host)) return false;

  return true;
};

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
};

export const captureServerEvent = async (
  event: string,
  level: TelemetryLevel,
  context: CaptureContext = {},
): Promise<void> => {
  if (!isTelemetryEnabled(context.request)) return;

  const host = resolvePosthogHost();
  const key = resolvePosthogKey();
  if (!host || !key) return;

  const distinctId = context.distinctId || 'grad-planner-agent-server';
  const payload = {
    api_key: key,
    event,
    properties: {
      ...context.properties,
      level,
      route: context.route || 'unknown',
      source: 'grad-planner-agent',
      env: process.env.NODE_ENV || 'unknown',
    },
    distinct_id: distinctId,
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(`${host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
  } catch {
    // Telemetry must never block request handling.
  }
};

export const captureServerError = async (
  event: string,
  error: unknown,
  context: CaptureContext = {},
): Promise<void> =>
  captureServerEvent(event, 'error', {
    ...context,
    properties: {
      ...context.properties,
      errorMessage: safeErrorMessage(error),
    },
  });

