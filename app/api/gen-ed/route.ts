import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
    const year = req.nextUrl.searchParams.get('year') ?? '2024';
    const file = year === 'pre-2024'
        ? 'gen-ed-religion-pre-2024.json'
        : 'gen-ed-religion-2024.json';

    try {
        const raw = await fs.readFile(path.join(process.cwd(), file), 'utf-8');
        const data = JSON.parse(raw);
        return NextResponse.json(data);
    } catch {
        return NextResponse.json({ error: 'Gen-ed data not found.' }, { status: 404 });
    }
}
