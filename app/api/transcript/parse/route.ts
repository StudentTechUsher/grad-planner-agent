import { NextRequest, NextResponse } from 'next/server';
import { parseTranscriptPdf, parseTranscriptText } from '@/lib/transcriptParser';

export async function POST(req: NextRequest) {
    try {
        const isTextMode = req.nextUrl.searchParams.get('mode') === 'text';

        if (isTextMode) {
            // JSON body with { text } field
            const body = await req.json();
            const text = body?.text;

            if (!text || typeof text !== 'string' || text.trim().length < 50) {
                return NextResponse.json({ error: 'Please provide at least 50 characters of transcript text.' }, { status: 400 });
            }

            const result = await parseTranscriptText(text);
            return NextResponse.json(result);
        }

        // Multipart form data with PDF file
        const formData = await req.formData();
        const file = formData.get('file');

        if (!file || !(file instanceof Blob)) {
            return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const fileName = (file as File).name ?? 'transcript.pdf';

        if (buffer.length > 10 * 1024 * 1024) {
            return NextResponse.json({ error: 'File must be less than 10MB.' }, { status: 400 });
        }

        const result = await parseTranscriptPdf(buffer, fileName);
        return NextResponse.json(result);
    } catch (e: any) {
        console.error('Transcript parse error:', e);
        return NextResponse.json(
            { success: false, error: e.message || 'Failed to parse transcript.' },
            { status: 500 }
        );
    }
}
