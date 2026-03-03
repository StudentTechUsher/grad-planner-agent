import { NextResponse } from 'next/server';
import { getAgentSessionFromRequest, getAgentRelaunchUrl, withRefreshedAgentSession } from '@/lib/agentAuth';
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin';
import { captureServerError, captureServerEvent } from '@/lib/posthogServer';
import { store } from '@/app/api/store';
import { evaluatePlanHeuristics } from '@/app/api/chat/tools';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type FinalizeBody = {
  planId?: string;
  planName?: string;
};

type BootstrapIdentity = {
  userIds: string[];
  profileIds: string[];
};

const GRAD_PLAN_TABLE = process.env.GRAD_PLAN_TABLE || 'grad_plan';
const GRAD_PLAN_ID_COLUMN = process.env.GRAD_PLAN_ID_COLUMN || 'id';
const GRAD_PLAN_USER_COLUMN_ENV = process.env.GRAD_PLAN_USER_COLUMN?.trim() || '';
const GRAD_PLAN_JSON_COLUMN = process.env.GRAD_PLAN_JSON_COLUMN || 'plan_details';
const GRAD_PLAN_ACTIVE_COLUMN = process.env.GRAD_PLAN_ACTIVE_COLUMN || 'is_active';
const GRAD_PLAN_NAME_COLUMN = process.env.GRAD_PLAN_NAME_COLUMN || 'plan_name';
const GRAD_PLAN_UPDATED_AT_COLUMN = process.env.GRAD_PLAN_UPDATED_AT_COLUMN || 'updated_at';
const GRAD_PLAN_PROGRAMS_COLUMN = process.env.GRAD_PLAN_PROGRAMS_COLUMN || 'programs_in_plan';
const GRAD_PLAN_ACTIVE_RPC = process.env.GRAD_PLAN_ACTIVE_RPC || '';
const GRAD_PLAN_ACTIVE_RPC_STUDENT_PARAM = process.env.GRAD_PLAN_ACTIVE_RPC_STUDENT_PARAM || 'p_student_id';
const GRAD_PLAN_ACTIVE_RPC_PLAN_PARAM = process.env.GRAD_PLAN_ACTIVE_RPC_PLAN_PARAM || 'p_plan_details';
const GRAD_PLAN_ACTIVE_RPC_PLAN_NAME_PARAM = process.env.GRAD_PLAN_ACTIVE_RPC_PLAN_NAME_PARAM || 'p_plan_name';
const GRAD_PLAN_ACTIVE_RPC_PROGRAMS_PARAM = process.env.GRAD_PLAN_ACTIVE_RPC_PROGRAMS_PARAM || '';
const GRAD_PLAN_RETURN_URL = process.env.GRAD_PLAN_RETURN_URL || 'https://app.stuplanning.com/grad-plan';
const MAX_PLAN_NAME_LENGTH = 120;
const HANDOFFS_TABLE = process.env.AGENT_HANDOFFS_TABLE || 'agent_handoffs';
const PROFILES_TABLE = process.env.AGENT_PROFILES_TABLE || 'profiles';
const PROFILES_AUTH_USER_COLUMN = process.env.AGENT_PROFILES_AUTH_USER_COLUMN || 'user_id';
const PROFILES_ID_COLUMN = process.env.AGENT_PROFILES_ID_COLUMN || 'id';
const PROFILES_STUDENT_ID_COLUMN = process.env.AGENT_PROFILES_STUDENT_ID_COLUMN || '';
const STUDENT_TABLE = process.env.AGENT_STUDENT_TABLE || 'student';
const STUDENT_ID_COLUMN = process.env.AGENT_STUDENT_ID_COLUMN || 'id';
const STUDENT_AUTH_USER_COLUMN = process.env.AGENT_STUDENT_AUTH_USER_COLUMN || 'user_id';
const STUDENT_PROFILE_COLUMN = process.env.AGENT_STUDENT_PROFILE_COLUMN || '';
const USER_COURSES_TABLE = process.env.AGENT_USER_COURSES_TABLE || 'user_courses';
const USER_COURSES_USER_COLUMN = process.env.AGENT_USER_COURSES_USER_COLUMN || 'user_id';
let cachedGradPlanOwnerColumn: string | null = GRAD_PLAN_USER_COLUMN_ENV || null;

const resolvePlanId = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  const parsedBody = body as FinalizeBody;
  if (typeof parsedBody.planId !== 'string' || !parsedBody.planId.trim()) return null;
  return parsedBody.planId;
};

const resolvePlanName = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  const parsedBody = body as FinalizeBody;
  if (typeof parsedBody.planName !== 'string') return null;
  const trimmed = parsedBody.planName.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MAX_PLAN_NAME_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_PLAN_NAME_LENGTH);
};

const resolveProgramIdsFromState = (state: { selectedProgramIds?: unknown; allCourses?: unknown }): string[] => {
  const source = Array.isArray(state.selectedProgramIds) ? state.selectedProgramIds : [];
  const deduped = new Set<string>();
  for (const value of source) {
    if (typeof value === 'string' && value.trim().length > 0) {
      deduped.add(value.trim());
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      deduped.add(String(value));
    }
  }

  const allCourses = Array.isArray(state.allCourses) ? state.allCourses : [];
  for (const courseCandidate of allCourses) {
    if (!courseCandidate || typeof courseCandidate !== 'object') continue;
    const course = courseCandidate as Record<string, unknown>;
    const programId = course.programId;
    if (typeof programId === 'string' && programId.trim().length > 0) {
      deduped.add(programId.trim());
      continue;
    }
    if (typeof programId === 'number' && Number.isFinite(programId)) {
      deduped.add(String(programId));
    }
  }

  return [...deduped];
};

const normalizeProgramIdsForDb = (programIds: string[]): string[] => {
  if (programIds.length === 0) return [];
  return programIds.map((programId) => programId.trim()).filter(Boolean);
};

const extractRpcPlanId = (data: unknown): string | null => {
  if (typeof data === 'string' || typeof data === 'number') return String(data);
  if (!data || typeof data !== 'object') return null;

  const record = data as Record<string, unknown>;
  const idCandidate = record[GRAD_PLAN_ID_COLUMN] ?? record.id ?? record.grad_plan_id;
  if (typeof idCandidate === 'string' || typeof idCandidate === 'number') {
    return String(idCandidate);
  }

  return null;
};

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

const addStringCandidate = (set: Set<string>, value: unknown): void => {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed) return;
  set.add(trimmed);
};

const isProfileOwnerColumn = (columnName: string): boolean =>
  columnName.trim().toLowerCase().includes('profile');

const isAuthUserOwnerColumn = (columnName: string): boolean => {
  const normalized = columnName.trim().toLowerCase();
  if (normalized.includes('student')) return false;
  return normalized === PROFILES_AUTH_USER_COLUMN.trim().toLowerCase() || normalized.includes('user');
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

  if (error || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  const rowCandidate: unknown = data[0];
  if (!rowCandidate || typeof rowCandidate !== 'object') return null;
  const row = rowCandidate as Record<string, unknown>;
  return toLookupValue(row[selectColumn]);
};

const hasRowForValue = async (
  table: string,
  filterColumn: string,
  filterValue: string | number,
): Promise<boolean> => {
  const supabaseAdmin = getSupabaseAdminClient();
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(filterColumn)
    .eq(filterColumn, filterValue)
    .limit(1);

  return !error && Array.isArray(data) && data.length > 0;
};

const resolveProfileId = async (authUserId: string): Promise<string | number | null> => {
  // If the principal is already a profile id, this resolves immediately.
  const profileIdDirect = await fetchSingleValue(
    PROFILES_TABLE,
    PROFILES_ID_COLUMN,
    PROFILES_ID_COLUMN,
    authUserId,
  );
  if (profileIdDirect !== null) return profileIdDirect;

  const profileId = await fetchSingleValue(
    PROFILES_TABLE,
    PROFILES_ID_COLUMN,
    PROFILES_AUTH_USER_COLUMN,
    authUserId,
  );
  if (profileId !== null) return profileId;

  const numericAuthId = toNumericCandidate(authUserId);
  if (numericAuthId === null) return null;

  const profileIdDirectNumeric = await fetchSingleValue(
    PROFILES_TABLE,
    PROFILES_ID_COLUMN,
    PROFILES_ID_COLUMN,
    numericAuthId,
  );
  if (profileIdDirectNumeric !== null) return profileIdDirectNumeric;

  return fetchSingleValue(
    PROFILES_TABLE,
    PROFILES_ID_COLUMN,
    PROFILES_AUTH_USER_COLUMN,
    numericAuthId,
  );
};

const tableHasColumn = async (table: string, column: string): Promise<boolean> => {
  const supabaseAdmin = getSupabaseAdminClient();
  const { error } = await supabaseAdmin.from(table).select(column).limit(1);
  return !error;
};

const resolveGradPlanOwnerColumn = async (): Promise<string> => {
  if (cachedGradPlanOwnerColumn) return cachedGradPlanOwnerColumn;

  // Prefer profile ownership when available, then student ownership, then user ownership.
  if (await tableHasColumn(GRAD_PLAN_TABLE, 'profile_id')) {
    cachedGradPlanOwnerColumn = 'profile_id';
    return cachedGradPlanOwnerColumn;
  }
  if (await tableHasColumn(GRAD_PLAN_TABLE, 'student_id')) {
    cachedGradPlanOwnerColumn = 'student_id';
    return cachedGradPlanOwnerColumn;
  }
  if (await tableHasColumn(GRAD_PLAN_TABLE, 'user_id')) {
    cachedGradPlanOwnerColumn = 'user_id';
    return cachedGradPlanOwnerColumn;
  }

  cachedGradPlanOwnerColumn = 'student_id';
  return cachedGradPlanOwnerColumn;
};

const extractIdentityCandidatesFromBootstrap = (bootstrapPayload: unknown): BootstrapIdentity => {
  const userIds = new Set<string>();
  const profileIds = new Set<string>();
  if (!bootstrapPayload || typeof bootstrapPayload !== 'object') {
    return { userIds: [], profileIds: [] };
  }

  const payload = bootstrapPayload as Record<string, unknown>;
  addStringCandidate(userIds, payload.userId);
  addStringCandidate(userIds, payload.authUserId);
  addStringCandidate(profileIds, payload.profileId);
  addStringCandidate(profileIds, payload.profile_id);

  const userCandidate = payload.user;
  if (userCandidate && typeof userCandidate === 'object') {
    const user = userCandidate as Record<string, unknown>;
    addStringCandidate(userIds, user.id);
    addStringCandidate(userIds, user.userId);
    addStringCandidate(userIds, user.authUserId);
    addStringCandidate(profileIds, user.profileId);
    addStringCandidate(profileIds, user.profile_id);
  }

  const profileCandidate = payload.profile;
  if (profileCandidate && typeof profileCandidate === 'object') {
    const profile = profileCandidate as Record<string, unknown>;
    addStringCandidate(profileIds, profile.id);
    addStringCandidate(profileIds, profile.profileId);
  }

  return {
    userIds: [...userIds],
    profileIds: [...profileIds],
  };
};

const fetchBootstrapIdentity = async (handoffId: string): Promise<BootstrapIdentity> => {
  const supabaseAdmin = getSupabaseAdminClient();
  const { data, error } = await supabaseAdmin
    .from(HANDOFFS_TABLE)
    .select('bootstrap_payload')
    .eq('id', handoffId)
    .limit(1);

  if (error || !Array.isArray(data) || data.length === 0) {
    return { userIds: [], profileIds: [] };
  }
  const row = data[0];
  if (!row || typeof row !== 'object') {
    return { userIds: [], profileIds: [] };
  }
  const bootstrapPayload = (row as Record<string, unknown>).bootstrap_payload;
  return extractIdentityCandidatesFromBootstrap(bootstrapPayload);
};

const resolveStudentId = async (authUserId: string): Promise<string | number | null> => {
  const principalCandidates: Array<string | number> = [authUserId];
  const numericAuthId = toNumericCandidate(authUserId);
  if (numericAuthId !== null) {
    principalCandidates.push(numericAuthId);
  }

  // Primary path: resolve directly from student.user_id = auth user id.
  if (STUDENT_AUTH_USER_COLUMN) {
    for (const principal of principalCandidates) {
      const studentIdFromAuthUser = await fetchSingleValue(
        STUDENT_TABLE,
        STUDENT_ID_COLUMN,
        STUDENT_AUTH_USER_COLUMN,
        principal,
      );
      if (studentIdFromAuthUser !== null) return studentIdFromAuthUser;
    }
  }

  // Fallback: some handoff integrations set principal to student.id directly.
  for (const principal of principalCandidates) {
    const studentIdDirect = await fetchSingleValue(
      STUDENT_TABLE,
      STUDENT_ID_COLUMN,
      STUDENT_ID_COLUMN,
      principal,
    );
    if (studentIdDirect !== null) return studentIdDirect;
  }

  // Secondary path for schemas that link student -> profile.id (or similar).
  const profileId = await fetchSingleValue(
    PROFILES_TABLE,
    PROFILES_ID_COLUMN,
    PROFILES_AUTH_USER_COLUMN,
    authUserId,
  );

  if (profileId !== null) {
    if (STUDENT_PROFILE_COLUMN) {
      const studentIdFromProfile = await fetchSingleValue(
        STUDENT_TABLE,
        STUDENT_ID_COLUMN,
        STUDENT_PROFILE_COLUMN,
        profileId,
      );
      if (studentIdFromProfile !== null) return studentIdFromProfile;
    }

    // Alternate schema: student.user_id stores profile id instead of auth user id.
    if (STUDENT_AUTH_USER_COLUMN) {
      const studentIdFromProfileAsUser = await fetchSingleValue(
        STUDENT_TABLE,
        STUDENT_ID_COLUMN,
        STUDENT_AUTH_USER_COLUMN,
        profileId,
      );
      if (studentIdFromProfileAsUser !== null) return studentIdFromProfileAsUser;
    }
  }

  if (PROFILES_STUDENT_ID_COLUMN) {
    const studentIdFromProfile = await fetchSingleValue(
      PROFILES_TABLE,
      PROFILES_STUDENT_ID_COLUMN,
      PROFILES_AUTH_USER_COLUMN,
      authUserId,
    );
    if (studentIdFromProfile !== null) return studentIdFromProfile;
  }

  return null;
};

const resolveGradPlanOwnerId = async (
  authUserId: string,
  ownerColumn: string,
): Promise<string | number | null> => {
  if (isProfileOwnerColumn(ownerColumn)) {
    return resolveProfileId(authUserId);
  }

  if (isAuthUserOwnerColumn(ownerColumn)) {
    const numericAuthId = toNumericCandidate(authUserId);
    return numericAuthId ?? authUserId;
  }

  return resolveStudentId(authUserId);
};

const resolveGradPlanOwnerFromCandidates = async (
  ownerColumn: string,
  candidates: string[],
): Promise<string | number | null> => {
  for (const candidate of candidates) {
    const ownerId = await resolveGradPlanOwnerId(candidate, ownerColumn);
    if (ownerId !== null) return ownerId;
  }
  return null;
};

const resolveUserCoursesLookupId = async (candidates: string[]): Promise<string | null> => {
  for (const candidate of candidates) {
    if (await hasRowForValue(USER_COURSES_TABLE, USER_COURSES_USER_COLUMN, candidate)) {
      return candidate;
    }
    const numericCandidate = toNumericCandidate(candidate);
    if (numericCandidate !== null) {
      if (await hasRowForValue(USER_COURSES_TABLE, USER_COURSES_USER_COLUMN, numericCandidate)) {
        return candidate;
      }
    }
  }

  return null;
};

export async function POST(req: Request) {
  const session = await getAgentSessionFromRequest(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized', relaunchUrl: getAgentRelaunchUrl('unauthorized_finalize') },
      { status: 401 },
    );
  }
  const jsonWithSession = (body: unknown, init?: ResponseInit) =>
    withRefreshedAgentSession(NextResponse.json(body, init), session);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonWithSession({ error: 'Invalid request body.' }, { status: 400 });
  }

  const planId = resolvePlanId(body);
  if (!planId) {
    return jsonWithSession({ error: 'planId is required.' }, { status: 400 });
  }
  const planName = resolvePlanName(body) || 'My Graduation Plan';

  const state = store.get(planId);
  if (!state) {
    return jsonWithSession({ error: 'Plan state not found.' }, { status: 404 });
  }

  if (!state.userId) {
    return jsonWithSession({ error: 'Plan state is missing ownership metadata.' }, { status: 409 });
  }

  if (state.userId && state.userId !== session.userId) {
    return jsonWithSession({ error: 'Forbidden: plan ownership mismatch.' }, { status: 403 });
  }

  const heuristics = evaluatePlanHeuristics(state);
  if (!heuristics.isPlanSound || heuristics.totalUnplanned > 0) {
    void captureServerEvent('finalize_blocked_heuristics', 'warn', {
      route: '/api/plan/finalize',
      request: req,
      distinctId: session.userId,
      properties: {
        planId,
        isPlanSound: heuristics.isPlanSound,
        totalUnplanned: heuristics.totalUnplanned,
        warningCount: Array.isArray(heuristics.warnings) ? heuristics.warnings.length : 0,
      },
    });
    return jsonWithSession(
      {
        error: 'Plan is not ready to finalize. Resolve heuristics first.',
        heuristics,
      },
      { status: 400 },
    );
  }

  const persistedPayload = {
    planId,
    planName,
    plan: state.terms,
    milestones: state.milestones,
    programIds: resolveProgramIdsFromState(state),
    preferences: state.preferences,
    phases: state.phases,
    finalizedAt: new Date().toISOString(),
  };

  try {
    const supabaseAdmin = getSupabaseAdminClient();
    const gradPlanOwnerColumn = await resolveGradPlanOwnerColumn();
    const principalCandidates = new Set<string>();
    addStringCandidate(principalCandidates, session.userId);

    const bootstrapIdentity = await fetchBootstrapIdentity(session.handoffId);
    if (isProfileOwnerColumn(gradPlanOwnerColumn)) {
      for (const profileCandidate of bootstrapIdentity.profileIds) {
        addStringCandidate(principalCandidates, profileCandidate);
      }
    }
    for (const userCandidate of bootstrapIdentity.userIds) {
      addStringCandidate(principalCandidates, userCandidate);
    }
    for (const profileCandidate of bootstrapIdentity.profileIds) {
      addStringCandidate(principalCandidates, profileCandidate);
    }

    const principalCandidateList = [...principalCandidates];
    let ownerId: string | number | null = null;

    // Keep finalize ownership aligned with transcript context lookup key.
    const userCoursesLookupId = await resolveUserCoursesLookupId(principalCandidateList);
    if (isProfileOwnerColumn(gradPlanOwnerColumn) && userCoursesLookupId) {
      ownerId = userCoursesLookupId;
    }

    if (ownerId === null) {
      ownerId = await resolveGradPlanOwnerFromCandidates(
        gradPlanOwnerColumn,
        principalCandidateList,
      );
    }
    if (ownerId === null) {
      void captureServerEvent('finalize_owner_resolution_failed', 'warn', {
        route: '/api/plan/finalize',
        request: req,
        distinctId: session.userId,
        properties: {
          planId,
          ownerColumn: gradPlanOwnerColumn,
          principalCandidates: principalCandidateList,
        },
      });
      return jsonWithSession(
        {
          error: `Unable to resolve authenticated user to ${gradPlanOwnerColumn}.`,
          hint:
            gradPlanOwnerColumn === 'profile_id'
              ? 'Ensure profiles.id exists for this user and bootstrap includes user/profile identifiers.'
              : undefined,
        },
        { status: 404 },
      );
    }

    // Optional preferred path: DB-side transaction/RPC when configured.
    if (GRAD_PLAN_ACTIVE_RPC) {
      const rpcArgs: Record<string, unknown> = {
        [GRAD_PLAN_ACTIVE_RPC_STUDENT_PARAM]: ownerId,
        [GRAD_PLAN_ACTIVE_RPC_PLAN_PARAM]: persistedPayload,
      };
      if (GRAD_PLAN_ACTIVE_RPC_PLAN_NAME_PARAM) {
        rpcArgs[GRAD_PLAN_ACTIVE_RPC_PLAN_NAME_PARAM] = planName;
      }
      if (GRAD_PLAN_ACTIVE_RPC_PROGRAMS_PARAM) {
        rpcArgs[GRAD_PLAN_ACTIVE_RPC_PROGRAMS_PARAM] = normalizeProgramIdsForDb(persistedPayload.programIds);
      }

      const rpcResult = await supabaseAdmin.rpc(GRAD_PLAN_ACTIVE_RPC, rpcArgs);
      if (!rpcResult.error) {
        const gradPlanId = extractRpcPlanId(rpcResult.data);
        return jsonWithSession({
          success: true,
          gradPlanId,
          planName,
          redirectTo: GRAD_PLAN_RETURN_URL,
        });
      }
    }

    // Default path: deactivate current active plan(s), then insert the new active plan.
    await supabaseAdmin
      .from(GRAD_PLAN_TABLE)
      .update({ [GRAD_PLAN_ACTIVE_COLUMN]: false })
      .eq(gradPlanOwnerColumn, ownerId)
      .eq(GRAD_PLAN_ACTIVE_COLUMN, true);

    const insertPayload: Record<string, unknown> = {
      [gradPlanOwnerColumn]: ownerId,
      [GRAD_PLAN_JSON_COLUMN]: persistedPayload,
      [GRAD_PLAN_ACTIVE_COLUMN]: true,
    };
    insertPayload[GRAD_PLAN_PROGRAMS_COLUMN] = normalizeProgramIdsForDb(persistedPayload.programIds);
    insertPayload[GRAD_PLAN_NAME_COLUMN] = planName;
    insertPayload[GRAD_PLAN_UPDATED_AT_COLUMN] = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from(GRAD_PLAN_TABLE)
      .insert(insertPayload)
      .select(GRAD_PLAN_ID_COLUMN)
      .single();

    if (error) {
      void captureServerEvent('finalize_insert_failed', 'error', {
        route: '/api/plan/finalize',
        request: req,
        distinctId: session.userId,
        properties: {
          planId,
          ownerColumn: gradPlanOwnerColumn,
          errorMessage: error.message,
        },
      });
      return jsonWithSession({ error: `Failed to persist grad plan: ${error.message}` }, { status: 500 });
    }

    const row = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const gradPlanId =
      typeof row[GRAD_PLAN_ID_COLUMN] === 'string' || typeof row[GRAD_PLAN_ID_COLUMN] === 'number'
        ? String(row[GRAD_PLAN_ID_COLUMN])
        : null;

    return jsonWithSession({
      success: true,
      gradPlanId,
      planName,
      redirectTo: GRAD_PLAN_RETURN_URL,
    });
  } catch (error) {
    void captureServerError('finalize_unexpected_error', error, {
      route: '/api/plan/finalize',
      request: req,
      distinctId: session.userId,
      properties: { planId },
    });
    return jsonWithSession(
      {
        error: error instanceof Error ? error.message : 'Finalize failed unexpectedly.',
      },
      { status: 500 },
    );
  }
}
