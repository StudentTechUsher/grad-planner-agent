import { NextResponse } from 'next/server';

import {
  getAgentSessionFromRequest,
  getAgentRelaunchUrl,
  withRefreshedAgentSession,
} from '@/lib/agentAuth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import {
  enforcePayloadSize,
  saveSessionTranscript,
  sanitizeStateSnapshot,
  isValidSessionId,
} from '@/lib/aiSessions';
import { captureServerError, captureServerEvent } from '@/lib/posthogServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type SyncBody = {
  chatMessages?: unknown;
  stateSnapshot?: unknown;
};

export async function PUT(
  req: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const session = await getAgentSessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized', relaunchUrl: getAgentRelaunchUrl('unauthorized_session_sync') },
      { status: 401 },
    );
  }

  const jsonWithSession = (body: unknown, init?: ResponseInit) =>
    withRefreshedAgentSession(NextResponse.json(body, init), session);

  const { sessionId } = await context.params;
  if (!isValidSessionId(sessionId)) {
    return jsonWithSession({ error: 'Invalid sessionId.' }, { status: 400 });
  }

  let body: SyncBody;
  try {
    body = (await req.json()) as SyncBody;
  } catch {
    return jsonWithSession({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!Array.isArray(body.chatMessages)) {
    return jsonWithSession(
      { error: 'chatMessages must be an array.' },
      { status: 400 },
    );
  }

  const stateSnapshot = sanitizeStateSnapshot(body.stateSnapshot ?? {});

  const sizeResult = enforcePayloadSize({
    chatMessages: body.chatMessages,
    stateSnapshot,
  });

  if (!sizeResult.ok) {
    void captureServerEvent('session_payload_too_large', 'warn', {
      route: '/api/session/conversation/[sessionId]',
      request: req,
      distinctId: session.userId,
      properties: {
        sessionId,
        bytes: sizeResult.bytes,
        maxBytes: sizeResult.maxBytes,
      },
    });

    return jsonWithSession(
      {
        error: `Session payload too large (${sizeResult.bytes} bytes).`,
      },
      { status: 413 },
    );
  }

  try {
    const supabaseAdmin = getSupabaseAdminClient();
    const saved = await saveSessionTranscript({
      supabaseAdmin,
      userId: session.userId,
      sessionId,
      chatMessages: body.chatMessages,
      stateSnapshot,
      createIfMissing: false,
    });

    if (!saved) {
      return jsonWithSession(
        { error: 'Session not found or expired.' },
        { status: 404 },
      );
    }

    return jsonWithSession({
      success: true,
      updatedAt: saved.updated_at ?? saved.last_activity_at ?? new Date().toISOString(),
    });
  } catch (error) {
    void captureServerError('session_sync_failed', error, {
      route: '/api/session/conversation/[sessionId]',
      request: req,
      distinctId: session.userId,
      properties: { sessionId },
    });

    return jsonWithSession(
      {
        error: error instanceof Error ? error.message : 'Failed to sync session payload.',
      },
      { status: 500 },
    );
  }
}
