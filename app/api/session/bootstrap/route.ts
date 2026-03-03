import { NextResponse } from 'next/server';
import { getAgentSessionFromRequest, getAgentRelaunchUrl, withRefreshedAgentSession } from '@/lib/agentAuth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HANDOFFS_TABLE = process.env.AGENT_HANDOFFS_TABLE || 'agent_handoffs';

const normalizeBootstrap = (candidate: unknown): Record<string, unknown> => {
  if (!candidate || typeof candidate !== 'object') return {};
  return candidate as Record<string, unknown>;
};

export async function GET(req: Request) {
  const session = await getAgentSessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized', relaunchUrl: getAgentRelaunchUrl('unauthorized_bootstrap') },
      { status: 401 },
    );
  }

  try {
    const supabaseAdmin = getSupabaseAdminClient();

    const { data, error } = await supabaseAdmin
      .from(HANDOFFS_TABLE)
      .select('id, user_id, bootstrap_payload')
      .eq('id', session.handoffId)
      .eq('user_id', session.userId)
      .single();

    if (error || !data) {
      return withRefreshedAgentSession(NextResponse.json(
        {
          user: { id: session.userId, email: session.email ?? null },
          bootstrap: {},
        },
        { status: 200 },
      ), session);
    }

    const bootstrap = normalizeBootstrap(data.bootstrap_payload);
    return withRefreshedAgentSession(NextResponse.json({
      user: {
        id: session.userId,
        email: session.email ?? null,
      },
      bootstrap,
    }), session);
  } catch {
    return withRefreshedAgentSession(NextResponse.json(
      {
        user: { id: session.userId, email: session.email ?? null },
        bootstrap: {},
        warning: 'Bootstrap payload unavailable; continuing with empty defaults.',
      },
      { status: 200 },
    ), session);
  }
}
