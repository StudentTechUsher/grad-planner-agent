import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { getAgentSessionFromRequest, withRefreshedAgentSession } from '@/lib/agentAuth';

export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
    const session = await getAgentSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const type = req.nextUrl.searchParams.get('type') || 'major';

    const { data, error } = await supabase
        .from('program')
        .select('id, name, minimum_credits, target_total_credits')
        .eq('university_id', '1')
        .eq('program_type', type);

    if (error) {
        return withRefreshedAgentSession(
            NextResponse.json({ error: error.message }, { status: 500 }),
            session,
        );
    }

    return withRefreshedAgentSession(NextResponse.json({ programs: data ?? [] }), session);
}
