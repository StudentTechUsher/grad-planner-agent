import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
    const type = req.nextUrl.searchParams.get('type') || 'major';

    const { data, error } = await supabase
        .from('program')
        .select('name, minimum_credits, target_total_credits')
        .eq('university_id', '1')
        .eq('program_type', type);

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ programs: data ?? [] });
}
