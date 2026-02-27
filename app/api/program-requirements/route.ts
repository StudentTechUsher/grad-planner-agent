import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import fs from 'fs/promises';
import path from 'path';

function toSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[()]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
    const program = req.nextUrl.searchParams.get('program') ?? '';
    const type = req.nextUrl.searchParams.get('type') ?? 'major';

    if (!program) {
        return NextResponse.json({ error: 'Missing program parameter' }, { status: 400 });
    }

    // Query Supabase — same pattern as /api/programs but includes the requirements column
    const { data, error } = await supabase
        .from('program')
        .select('name, requirements, minimum_credits, target_total_credits')
        .eq('university_id', '1')
        .eq('program_type', type)
        .ilike('name', program)
        .single();

    if (!error && data?.requirements) {
        const reqs = typeof data.requirements === 'string'
            ? JSON.parse(data.requirements)
            : data.requirements;
        return NextResponse.json({
            programName: data.name,
            programRequirements: Array.isArray(reqs) ? reqs : reqs.programRequirements ?? [],
        });
    }

    // Fallback: try local JSON file (e.g. information-systems-bsis.json)
    try {
        const slug = toSlug(program);
        const raw = await fs.readFile(path.join(process.cwd(), `${slug}.json`), 'utf-8');
        return NextResponse.json(JSON.parse(raw));
    } catch {
        return NextResponse.json(
            { error: `No requirements found for: ${program}` },
            { status: 404 }
        );
    }
}
