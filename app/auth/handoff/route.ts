import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import { setAgentSessionCookie, verifyHandoffToken, getAgentRelaunchUrl } from '@/lib/agentAuth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HANDOFFS_TABLE = process.env.AGENT_HANDOFFS_TABLE || 'agent_handoffs';

const redirectToRelaunch = (reason: string) =>
  NextResponse.redirect(getAgentRelaunchUrl(reason), { status: 302 });

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return redirectToRelaunch('missing_handoff_token');

  const claims = verifyHandoffToken(token);
  if (!claims) return redirectToRelaunch('invalid_handoff_token');

  try {
    const supabaseAdmin = getSupabaseAdminClient();
    const nowIso = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from(HANDOFFS_TABLE)
      .update({ used_at: nowIso })
      .eq('id', claims.handoffId)
      .eq('user_id', claims.userId)
      .is('used_at', null)
      .gt('expires_at', nowIso)
      .select('id, user_id, bootstrap_payload')
      .single();

    if (error || !data) {
      return redirectToRelaunch('expired_or_used_handoff');
    }

    const bootstrapPayload =
      data && typeof data.bootstrap_payload === 'object' && data.bootstrap_payload !== null
        ? (data.bootstrap_payload as Record<string, unknown>)
        : {};

    const email =
      typeof bootstrapPayload?.user === 'object' &&
      bootstrapPayload.user !== null &&
      typeof (bootstrapPayload.user as Record<string, unknown>).email === 'string'
        ? ((bootstrapPayload.user as Record<string, unknown>).email as string)
        : claims.email;

    const response = NextResponse.redirect(new URL('/', req.url), { status: 302 });
    setAgentSessionCookie(response, {
      userId: data.user_id,
      handoffId: data.id,
      email,
    });

    return response;
  } catch {
    return redirectToRelaunch('handoff_consume_failed');
  }
}
