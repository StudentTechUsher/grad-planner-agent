import { NextResponse } from 'next/server';
import { getAgentSessionFromRequest, withRefreshedAgentSession } from '@/lib/agentAuth';
import { captureServerEvent } from '@/lib/posthogServer';

type ClientErrorBody = {
  event?: string;
  message?: string;
  context?: Record<string, unknown>;
};

const normalizeMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'Unknown client error';
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const session = await getAgentSessionFromRequest(req);

  let body: ClientErrorBody | null = null;
  try {
    body = (await req.json()) as ClientErrorBody;
  } catch {
    // Ignore invalid payloads; this endpoint should never break client workflows.
  }

  const eventName = typeof body?.event === 'string' && body.event.trim() ? body.event.trim() : 'client_error';
  const message = normalizeMessage(body?.message);

  void captureServerEvent(eventName, 'error', {
    route: '/api/telemetry/client-error',
    request: req,
    distinctId: session?.userId ?? null,
    properties: {
      message,
      ...(body?.context && typeof body.context === 'object' ? { context: body.context } : {}),
    },
  });

  const response = NextResponse.json({ success: true });
  if (session) {
    return withRefreshedAgentSession(response, session);
  }
  return response;
}
