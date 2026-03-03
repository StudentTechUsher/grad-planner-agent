import { NextRequest, NextResponse } from 'next/server';
import { parseTranscriptPdf, parseTranscriptText } from '@/lib/transcriptParser';
import { getAgentSessionFromRequest, withRefreshedAgentSession } from '@/lib/agentAuth';
import { captureServerError } from '@/lib/posthogServer';

export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest) {
    const session = await getAgentSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const isTextMode = req.nextUrl.searchParams.get('mode') === 'text';

        if (isTextMode) {
            // JSON body with { text } field
            const body = await req.json();
            const text = body?.text;

            if (!text || typeof text !== 'string' || text.trim().length < 50) {
                return withRefreshedAgentSession(
                    NextResponse.json({ error: 'Please provide at least 50 characters of transcript text.' }, { status: 400 }),
                    session,
                );
            }

            const result = await parseTranscriptText(text);
            return withRefreshedAgentSession(NextResponse.json(result), session);
        }

        // Multipart form data with PDF file
        const formData = await req.formData();
        const file = formData.get('file');

        if (!file || !(file instanceof Blob)) {
            return withRefreshedAgentSession(
                NextResponse.json({ error: 'No file uploaded.' }, { status: 400 }),
                session,
            );
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        const fileName = (file as File).name ?? 'transcript.pdf';

        if (buffer.length > 10 * 1024 * 1024) {
            return withRefreshedAgentSession(
                NextResponse.json({ error: 'File must be less than 10MB.' }, { status: 400 }),
                session,
            );
        }

        const result = await parseTranscriptPdf(buffer, fileName);
        return withRefreshedAgentSession(NextResponse.json(result), session);
    } catch (e: unknown) {
        void captureServerError('transcript_parse_failed', e, {
            route: '/api/transcript/parse',
            request: req,
            distinctId: session.userId,
        });
        return withRefreshedAgentSession(NextResponse.json(
            { success: false, error: e instanceof Error ? e.message : 'Failed to parse transcript.' },
            { status: 500 }
        ), session);
    }
}
