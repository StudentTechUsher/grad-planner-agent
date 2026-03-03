import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getAgentSessionFromRequest, withRefreshedAgentSession } from '@/lib/agentAuth';
import { supabase } from '@/lib/supabase';

type ProgramRow = {
    id?: string | number | null;
    name?: string | null;
    requirements?: unknown;
};

const normalizeRequirements = (requirements: unknown): unknown[] => {
    if (!requirements) return [];
    if (typeof requirements === 'string') {
        try {
            const parsed = JSON.parse(requirements);
            if (Array.isArray(parsed)) return parsed;
            if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).programRequirements)) {
                return (parsed as Record<string, unknown>).programRequirements as unknown[];
            }
            return [];
        } catch {
            return [];
        }
    }
    if (Array.isArray(requirements)) return requirements;
    if (requirements && typeof requirements === 'object' && Array.isArray((requirements as Record<string, unknown>).programRequirements)) {
        return (requirements as Record<string, unknown>).programRequirements as unknown[];
    }
    return [];
};

const scoreGenEdRow = (row: ProgramRow, year: '2024' | 'pre-2024'): number => {
    const name = (row.name || '').toLowerCase();
    let score = 0;

    if (year === 'pre-2024') {
        if (name.includes('pre-2024') || name.includes('pre 2024')) score += 100;
        if (name.includes('legacy') || name.includes('old')) score += 25;
        if (name.includes('2024')) score -= 50;
        return score;
    }

    // year === '2024'
    if (name.includes('2024+') || name.includes('2024 +')) score += 100;
    if (name.includes('2024') && !name.includes('pre')) score += 60;
    if (name.includes('latest') || name.includes('current')) score += 20;
    if (name.includes('pre-2024') || name.includes('pre 2024')) score -= 50;
    return score;
};

const pickBestGenEdRow = (rows: ProgramRow[], year: '2024' | 'pre-2024'): ProgramRow | null => {
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0];

    const ranked = rows
        .map((row) => ({ row, score: scoreGenEdRow(row, year) }))
        .sort((a, b) => b.score - a.score);

    return ranked[0]?.row ?? null;
};

export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
    const session = await getAgentSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const year = req.nextUrl.searchParams.get('year') ?? '2024';
    const normalizedYear: '2024' | 'pre-2024' = year === 'pre-2024' ? 'pre-2024' : '2024';

    const selectColumns = 'id, name, requirements';
    // Preferred path: explicit general-ed flag.
    const query = supabase
        .from('program')
        .select(selectColumns)
        .eq('university_id', '1')
        .eq('is_general_ed', true);

    const { data: flaggedRowsRaw, error: flaggedError } = await query;
    let candidateRows: ProgramRow[] = Array.isArray(flaggedRowsRaw) ? flaggedRowsRaw as ProgramRow[] : [];

    // Fallback path: legacy program_type.
    if ((!candidateRows || candidateRows.length === 0) || flaggedError) {
        const { data: typeRowsRaw } = await supabase
            .from('program')
            .select(selectColumns)
            .eq('university_id', '1')
            .eq('program_type', 'gen_ed');
        candidateRows = Array.isArray(typeRowsRaw) ? typeRowsRaw as ProgramRow[] : [];
    }

    const selectedProgram = pickBestGenEdRow(candidateRows, normalizedYear);
    const programRequirements = normalizeRequirements(selectedProgram?.requirements);
    if (selectedProgram && programRequirements.length > 0) {
        return withRefreshedAgentSession(NextResponse.json({
            programId: selectedProgram.id ?? null,
            programName: selectedProgram.name ?? `General Education (${normalizedYear})`,
            programRequirements,
        }), session);
    }

    // Safety fallback to local files if DB rows are unavailable/malformed.
    const file = normalizedYear === 'pre-2024'
        ? 'gen-ed-religion-pre-2024.json'
        : 'gen-ed-religion-2024.json';

    try {
        const raw = await fs.readFile(path.join(process.cwd(), file), 'utf-8');
        const data = JSON.parse(raw);
        return withRefreshedAgentSession(NextResponse.json({
            programId: null,
            programName: normalizedYear === 'pre-2024' ? 'General Education (Pre-2024)' : 'General Education (2024+)',
            programRequirements: Array.isArray(data?.programRequirements) ? data.programRequirements : [],
        }), session);
    } catch {
        return withRefreshedAgentSession(
            NextResponse.json({ error: 'Gen-ed data not found.' }, { status: 404 }),
            session,
        );
    }
}
