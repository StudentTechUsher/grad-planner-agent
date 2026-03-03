import { NextResponse } from 'next/server';
import { getAgentSessionFromRequest, withRefreshedAgentSession } from '@/lib/agentAuth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type LooseRecord = Record<string, unknown>;

type NormalizedTranscriptCourse = {
  subject: string;
  number: string;
  title: string;
  credits: number;
  grade: string;
  term: string;
};

const PROFILES_TABLE = process.env.AGENT_PROFILES_TABLE || 'profiles';
const PROFILES_AUTH_USER_COLUMN = process.env.AGENT_PROFILES_AUTH_USER_COLUMN || 'user_id';
const PROFILES_ID_COLUMN = process.env.AGENT_PROFILES_ID_COLUMN || 'id';

const USER_COURSES_TABLE = process.env.AGENT_USER_COURSES_TABLE || 'user_courses';
const USER_COURSES_USER_COLUMN = process.env.AGENT_USER_COURSES_USER_COLUMN || 'user_id';
const USER_COURSES_COURSES_COLUMN = process.env.AGENT_USER_COURSES_COURSES_COLUMN || 'courses';

const asObject = (value: unknown): LooseRecord | null =>
  value && typeof value === 'object' ? (value as LooseRecord) : null;

const toUpperTrim = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toUpperCase() : '';

const parseCourseCode = (rawCode: string): { subject: string; number: string } | null => {
  const cleaned = rawCode.trim().toUpperCase().replace(/\s+/g, ' ');

  let match = cleaned.match(/^([A-Z]{2,}(?: [A-Z]{1,3})?)\s*([0-9]{3}[A-Z]?)$/);
  if (match) {
    return { subject: match[1], number: match[2] };
  }

  const compact = cleaned.replace(/\s+/g, '');
  match = compact.match(/^([A-Z]+)([0-9]{3}[A-Z]?)$/);
  if (match) {
    return { subject: match[1], number: match[2] };
  }

  return null;
};

const coerceCourseArray = (raw: unknown): unknown[] => {
  if (Array.isArray(raw)) return raw;

  if (typeof raw === 'string') {
    try {
      return coerceCourseArray(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  const rawObj = asObject(raw);
  if (!rawObj) return [];

  if (Array.isArray(rawObj.courses)) return rawObj.courses;
  if (Array.isArray(rawObj.items)) return rawObj.items;

  return [];
};

const normalizeCourse = (raw: unknown): NormalizedTranscriptCourse | null => {
  const record = asObject(raw);
  if (!record) return null;

  let subject = toUpperTrim(record.subject);
  let number =
    typeof record.number === 'string'
      ? record.number.trim().toUpperCase()
      : typeof record.number === 'number'
        ? String(record.number)
        : '';

  const codeFromRow =
    typeof record.code === 'string'
      ? record.code
      : typeof record.course_code === 'string'
        ? record.course_code
        : typeof record.courseCode === 'string'
          ? record.courseCode
          : '';

  if ((!subject || !number) && codeFromRow) {
    const parsedFromCode = parseCourseCode(codeFromRow);
    if (parsedFromCode) {
      subject = parsedFromCode.subject;
      number = parsedFromCode.number;
    }
  }

  if (!subject || !number) return null;

  const titleCandidate =
    typeof record.title === 'string'
      ? record.title
      : typeof record.course_title === 'string'
        ? record.course_title
        : typeof record.courseTitle === 'string'
          ? record.courseTitle
          : codeFromRow;

  const creditsCandidate =
    typeof record.credits === 'number'
      ? record.credits
      : typeof record.credit_hours === 'number'
        ? record.credit_hours
        : typeof record.creditHours === 'number'
          ? record.creditHours
          : 3;

  const grade = typeof record.grade === 'string' ? record.grade : '';
  const term =
    typeof record.term === 'string'
      ? record.term
      : typeof record.semester === 'string'
        ? record.semester
        : '';

  return {
    subject,
    number,
    title: titleCandidate || `${subject} ${number}`,
    credits: Number.isFinite(creditsCandidate) ? Number(creditsCandidate) : 3,
    grade,
    term,
  };
};

const dedupeCourses = (courses: NormalizedTranscriptCourse[]): NormalizedTranscriptCourse[] => {
  const seen = new Set<string>();
  const result: NormalizedTranscriptCourse[] = [];

  for (const course of courses) {
    const key = `${course.subject}|${course.number}|${course.term}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(course);
  }

  return result;
};

const fetchProfileId = async (userId: string): Promise<string> => {
  const supabaseAdmin = getSupabaseAdminClient();

  const { data, error } = await supabaseAdmin
    .from(PROFILES_TABLE)
    .select(PROFILES_ID_COLUMN)
    .eq(PROFILES_AUTH_USER_COLUMN, userId)
    .limit(1);

  if (error || !Array.isArray(data) || data.length === 0) {
    return userId;
  }

  const row = asObject(data[0]);
  const profileIdCandidate = row?.[PROFILES_ID_COLUMN];
  if (typeof profileIdCandidate === 'string' && profileIdCandidate.length > 0) {
    return profileIdCandidate;
  }

  if (typeof profileIdCandidate === 'number') {
    return String(profileIdCandidate);
  }

  return userId;
};

const fetchCoursesRow = async (lookupUserId: string): Promise<LooseRecord | null> => {
  const supabaseAdmin = getSupabaseAdminClient();

  const { data, error } = await supabaseAdmin
    .from(USER_COURSES_TABLE)
    .select(USER_COURSES_COURSES_COLUMN)
    .eq(USER_COURSES_USER_COLUMN, lookupUserId)
    .limit(1);

  if (error || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  return asObject(data[0]);
};

export async function GET(req: Request) {
  const session = await getAgentSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const profileId = await fetchProfileId(session.userId);

    let coursesRow = await fetchCoursesRow(profileId);
    if (!coursesRow && profileId !== session.userId) {
      coursesRow = await fetchCoursesRow(session.userId);
    }

    const coursesRaw = coursesRow?.[USER_COURSES_COURSES_COLUMN] ?? null;
    const parsedCourses = coerceCourseArray(coursesRaw)
      .map((course) => normalizeCourse(course))
      .filter((course): course is NormalizedTranscriptCourse => course !== null);

    const transcriptCourses = dedupeCourses(parsedCourses);

    return withRefreshedAgentSession(NextResponse.json({
      profileId,
      hasExistingTranscript: transcriptCourses.length > 0,
      transcriptCourses,
      transcriptSummary:
        transcriptCourses.length > 0
          ? `Loaded ${transcriptCourses.length} transcript course${transcriptCourses.length === 1 ? '' : 's'} from your existing profile.`
          : '',
    }), session);
  } catch (error) {
    return withRefreshedAgentSession(NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load transcript context.',
      },
      { status: 500 },
    ), session);
  }
}
