import { NextRequest, NextResponse } from 'next/server';
import { parseTranscriptPdf, parseTranscriptText, type ParsedCourse, type TranscriptParseResult } from '@/lib/transcriptParser';
import { getAgentSessionFromRequest, withRefreshedAgentSession } from '@/lib/agentAuth';
import { captureServerError } from '@/lib/posthogServer';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const PROFILES_TABLE = process.env.AGENT_PROFILES_TABLE || 'profiles';
const PROFILES_AUTH_USER_COLUMN = process.env.AGENT_PROFILES_AUTH_USER_COLUMN || 'user_id';
const PROFILES_ID_COLUMN = process.env.AGENT_PROFILES_ID_COLUMN || 'id';
const USER_COURSES_TABLE = process.env.AGENT_USER_COURSES_TABLE || 'user_courses';
const USER_COURSES_USER_COLUMN = process.env.AGENT_USER_COURSES_USER_COLUMN || 'user_id';
const USER_COURSES_COURSES_COLUMN = process.env.AGENT_USER_COURSES_COURSES_COLUMN || 'courses';

const asObject = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const toLookupValue = (value: unknown): string | number | null => {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return null;
};

const toNumericCandidate = (value: string): number | null => {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) return null;
    return parsed;
};

const fetchSingleValue = async (
    table: string,
    selectColumn: string,
    filterColumn: string,
    filterValue: string | number,
): Promise<string | number | null> => {
    const supabaseAdmin = getSupabaseAdminClient();
    const { data, error } = await supabaseAdmin
        .from(table)
        .select(selectColumn)
        .eq(filterColumn, filterValue)
        .limit(1);

    if (error || !Array.isArray(data) || data.length === 0) return null;

    const row = asObject(data[0]);
    if (!row) return null;
    return toLookupValue(row[selectColumn]);
};

const resolveProfileLookupId = async (authUserId: string): Promise<string | null> => {
    const directProfileId = await fetchSingleValue(
        PROFILES_TABLE,
        PROFILES_ID_COLUMN,
        PROFILES_ID_COLUMN,
        authUserId,
    );
    if (directProfileId !== null) return String(directProfileId);

    const profileId = await fetchSingleValue(
        PROFILES_TABLE,
        PROFILES_ID_COLUMN,
        PROFILES_AUTH_USER_COLUMN,
        authUserId,
    );
    if (profileId !== null) return String(profileId);

    const numericAuthId = toNumericCandidate(authUserId);
    if (numericAuthId === null) return null;

    const numericProfileId = await fetchSingleValue(
        PROFILES_TABLE,
        PROFILES_ID_COLUMN,
        PROFILES_AUTH_USER_COLUMN,
        numericAuthId,
    );

    return numericProfileId !== null ? String(numericProfileId) : null;
};

const findExistingUserCoursesKey = async (
    lookupCandidates: string[],
): Promise<string | number | null> => {
    for (const candidate of lookupCandidates) {
        const directMatch = await fetchSingleValue(
            USER_COURSES_TABLE,
            USER_COURSES_USER_COLUMN,
            USER_COURSES_USER_COLUMN,
            candidate,
        );
        if (directMatch !== null) return directMatch;

        const numericCandidate = toNumericCandidate(candidate);
        if (numericCandidate === null) continue;

        const numericMatch = await fetchSingleValue(
            USER_COURSES_TABLE,
            USER_COURSES_USER_COLUMN,
            USER_COURSES_USER_COLUMN,
            numericCandidate,
        );
        if (numericMatch !== null) return numericMatch;
    }

    return null;
};

const enrichCoursesForPersistence = (courses: ParsedCourse[]): Array<ParsedCourse & { status: string; origin: string }> =>
    courses.map((course) => ({
        ...course,
        status: 'completed',
        origin: 'parsed',
    }));

const persistParsedTranscript = async (authUserId: string, courses: ParsedCourse[]): Promise<void> => {
    const supabaseAdmin = getSupabaseAdminClient();
    const profileId = await resolveProfileLookupId(authUserId);
    const lookupCandidates = profileId && profileId !== authUserId
        ? [profileId, authUserId]
        : [authUserId];
    const existingUserCoursesKey = await findExistingUserCoursesKey(lookupCandidates);
    const persistedCourses = enrichCoursesForPersistence(courses);

    if (existingUserCoursesKey !== null) {
        const { error } = await supabaseAdmin
            .from(USER_COURSES_TABLE)
            .update({ [USER_COURSES_COURSES_COLUMN]: persistedCourses })
            .eq(USER_COURSES_USER_COLUMN, existingUserCoursesKey);
        if (error) throw new Error(`Failed to update transcript courses: ${error.message}`);
        return;
    }

    const insertOwnerId = profileId ?? authUserId;
    const { error } = await supabaseAdmin
        .from(USER_COURSES_TABLE)
        .insert({
            [USER_COURSES_USER_COLUMN]: insertOwnerId,
            [USER_COURSES_COURSES_COLUMN]: persistedCourses,
        });
    if (error) throw new Error(`Failed to insert transcript courses: ${error.message}`);
};

const parseTranscriptFromRequest = async (req: NextRequest): Promise<TranscriptParseResult> => {
    const isTextMode = req.nextUrl.searchParams.get('mode') === 'text';

    if (isTextMode) {
        // JSON body with { text } field
        const body = await req.json();
        const text = body?.text;

        if (!text || typeof text !== 'string' || text.trim().length < 50) {
            throw new Error('Please provide at least 50 characters of transcript text.');
        }

        return parseTranscriptText(text);
    }

    // Multipart form data with PDF file
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof Blob)) {
        throw new Error('No file uploaded.');
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileName = (file as File).name ?? 'transcript.pdf';

    if (buffer.length > 10 * 1024 * 1024) {
        throw new Error('File must be less than 10MB.');
    }

    return parseTranscriptPdf(buffer, fileName);
};

export async function POST(req: NextRequest) {
    const session = await getAgentSessionFromRequest(req);
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const result = await parseTranscriptFromRequest(req);

        if (result.success && result.courseCount > 0) {
            await persistParsedTranscript(session.userId, result.courses);
        }
        return withRefreshedAgentSession(NextResponse.json(result), session);
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Failed to parse transcript.';
        const badRequestMessages = new Set([
            'Please provide at least 50 characters of transcript text.',
            'No file uploaded.',
            'File must be less than 10MB.',
        ]);
        const status = badRequestMessages.has(message) ? 400 : 500;

        void captureServerError('transcript_parse_failed', e, {
            route: '/api/transcript/parse',
            request: req,
            distinctId: session.userId,
        });
        return withRefreshedAgentSession(NextResponse.json(
            { success: false, error: message },
            { status }
        ), session);
    }
}
