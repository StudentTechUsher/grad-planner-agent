import { NextResponse } from 'next/server';

import {
  getAgentSessionFromRequest,
  getAgentRelaunchUrl,
  withRefreshedAgentSession,
} from '@/lib/agentAuth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import { captureServerError, captureServerEvent } from '@/lib/posthogServer';
import { resolveOrCreateSession } from '@/lib/aiSessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type ResolveRequestBody = {
  requestedSessionId?: string;
};

const parseBody = async (req: Request): Promise<ResolveRequestBody> => {
  try {
    const raw = await req.text();
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as ResolveRequestBody;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

export async function POST(req: Request) {
  const session = await getAgentSessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized', relaunchUrl: getAgentRelaunchUrl('unauthorized_session_resolve') },
      { status: 401 },
    );
  }

  const jsonWithSession = (body: unknown, init?: ResponseInit) =>
    withRefreshedAgentSession(NextResponse.json(body, init), session);

  try {
    const body = await parseBody(req);
    const supabaseAdmin = getSupabaseAdminClient();

    const { source, session: resolvedSession } = await resolveOrCreateSession({
      supabaseAdmin,
      userId: session.userId,
      requestedSessionId: body.requestedSessionId,
    });

    void captureServerEvent('session_resolve', 'info', {
      route: '/api/session/conversation/resolve',
      request: req,
      distinctId: session.userId,
      properties: {
        source,
        sessionId: resolvedSession.id,
      },
    });

    return jsonWithSession({
      sessionId: resolvedSession.id,
      source,
      chatMessages: resolvedSession.chat_messages,
      stateSnapshot: resolvedSession.state_snapshot,
      updatedAt:
        resolvedSession.updated_at ?? resolvedSession.last_activity_at ?? new Date().toISOString(),
    });
  } catch (error) {
    void captureServerError('session_resolve_failed', error, {
      route: '/api/session/conversation/resolve',
      request: req,
      distinctId: session.userId,
    });
    return jsonWithSession(
      {
        error:
          error instanceof Error ? error.message : 'Failed to resolve conversation session.',
      },
      { status: 500 },
    );
  }
}
