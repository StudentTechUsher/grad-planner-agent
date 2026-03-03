import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import fs from 'fs/promises';
import path from 'path';
import { getAgentSessionFromRequest, withRefreshedAgentSession } from '@/lib/agentAuth';

function toSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[()]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
    const session = await getAgentSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const program = req.nextUrl.searchParams.get('program') ?? '';
    const type = req.nextUrl.searchParams.get('type') ?? 'major';

    if (!program) {
        return withRefreshedAgentSession(
            NextResponse.json({ error: 'Missing program parameter' }, { status: 400 }),
            session,
        );
    }

    // Query Supabase — same pattern as /api/programs but includes the requirements column
    const { data, error } = await supabase
        .from('program')
        .select('id, name, requirements, minimum_credits, target_total_credits')
        .eq('university_id', '1')
        .eq('program_type', type)
        .ilike('name', program)
        .single();

    if (!error && data?.requirements) {
        const reqs = typeof data.requirements === 'string'
            ? JSON.parse(data.requirements)
            : data.requirements;
        return withRefreshedAgentSession(NextResponse.json({
            programId: data.id,
            programName: data.name,
            programRequirements: Array.isArray(reqs) ? reqs : reqs.programRequirements ?? [],
        }), session);
    }

    // Fallback: try local JSON file (e.g. information-systems-bsis.json)
    try {
        const slug = toSlug(program);
        const raw = await fs.readFile(path.join(process.cwd(), `${slug}.json`), 'utf-8');
        return withRefreshedAgentSession(NextResponse.json(JSON.parse(raw)), session);
    } catch {
        return withRefreshedAgentSession(NextResponse.json(
            { error: `No requirements found for: ${program}` },
            { status: 404 }
        ), session);
    }
}
