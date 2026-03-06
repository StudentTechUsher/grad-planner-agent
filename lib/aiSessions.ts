import { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

import type { ScaffoldState } from '@/app/api/store';

export type SessionResolveSource = 'requested' | 'latest' | 'created';

export type SessionStateSnapshot = {
  liveJson?: {
    plan?: unknown[];
    milestones?: unknown[];
    [key: string]: unknown;
  };
  preferences?: Record<string, unknown>;
  transcriptCourses?: unknown[];
  transcriptSummary?: string;
  storeState?: ScaffoldState;
  [key: string]: unknown;
};

export type SessionRecord = {
  id: string;
  user_id: string;
  chat_messages: unknown[];
  state_snapshot: SessionStateSnapshot;
  last_activity_at?: string;
  expires_at?: string;
  created_at?: string;
  updated_at?: string;
};

const DEFAULT_SESSIONS_TABLE = 'ai_sessions';
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_PAYLOAD_BYTES = 2_000_000;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const getSessionsTable = (): string =>
  process.env.AI_SESSIONS_TABLE?.trim() || DEFAULT_SESSIONS_TABLE;

export const getAiSessionsRetentionDays = (): number => {
  const parsed = Number(process.env.AI_SESSIONS_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(parsed);
};

export const getAiSessionsMaxPayloadBytes = (): number => {
  const parsed = Number(process.env.AI_SESSIONS_MAX_PAYLOAD_BYTES ?? DEFAULT_MAX_PAYLOAD_BYTES);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_PAYLOAD_BYTES;
  return Math.floor(parsed);
};

const getExpiresAtIso = (now = new Date()): string => {
  const next = new Date(now);
  next.setUTCDate(next.getUTCDate() + getAiSessionsRetentionDays());
  return next.toISOString();
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isValidSessionId = (value: unknown): value is string =>
  typeof value === 'string' && UUID_REGEX.test(value.trim());

export const sanitizeChatMessages = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export const sanitizeStateSnapshot = (value: unknown): SessionStateSnapshot =>
  isPlainObject(value) ? (value as SessionStateSnapshot) : {};

const sanitizeRecord = (candidate: unknown): SessionRecord | null => {
  if (!isPlainObject(candidate)) return null;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (typeof candidate.user_id !== 'string' || candidate.user_id.length === 0) return null;

  return {
    id: candidate.id,
    user_id: candidate.user_id,
    chat_messages: sanitizeChatMessages(candidate.chat_messages),
    state_snapshot: sanitizeStateSnapshot(candidate.state_snapshot),
    last_activity_at:
      typeof candidate.last_activity_at === 'string' ? candidate.last_activity_at : undefined,
    expires_at: typeof candidate.expires_at === 'string' ? candidate.expires_at : undefined,
    created_at: typeof candidate.created_at === 'string' ? candidate.created_at : undefined,
    updated_at: typeof candidate.updated_at === 'string' ? candidate.updated_at : undefined,
  };
};

const selectColumns =
  'id, user_id, chat_messages, state_snapshot, last_activity_at, expires_at, created_at, updated_at';

const getSessionById = async (
  supabaseAdmin: SupabaseClient,
  userId: string,
  sessionId: string,
  nowIso: string,
): Promise<SessionRecord | null> => {
  const { data, error } = await supabaseAdmin
    .from(getSessionsTable())
    .select(selectColumns)
    .eq('id', sessionId)
    .eq('user_id', userId)
    .gt('expires_at', nowIso)
    .maybeSingle();

  if (error || !data) return null;
  return sanitizeRecord(data);
};

const touchSession = async (
  supabaseAdmin: SupabaseClient,
  sessionId: string,
): Promise<SessionRecord | null> => {
  const nowIso = new Date().toISOString();
  const expiresAt = getExpiresAtIso();
  const { data, error } = await supabaseAdmin
    .from(getSessionsTable())
    .update({
      last_activity_at: nowIso,
      expires_at: expiresAt,
    })
    .eq('id', sessionId)
    .select(selectColumns)
    .maybeSingle();

  if (error || !data) return null;
  return sanitizeRecord(data);
};

export const resolveOrCreateSession = async ({
  supabaseAdmin,
  userId,
  requestedSessionId,
}: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  requestedSessionId?: string;
}): Promise<{ source: SessionResolveSource; session: SessionRecord }> => {
  const nowIso = new Date().toISOString();

  if (requestedSessionId && isValidSessionId(requestedSessionId)) {
    const requested = await getSessionById(
      supabaseAdmin,
      userId,
      requestedSessionId,
      nowIso,
    );
    if (requested) {
      const touched = await touchSession(supabaseAdmin, requested.id);
      return { source: 'requested', session: touched ?? requested };
    }
  }

  const { data: latestData } = await supabaseAdmin
    .from(getSessionsTable())
    .select(selectColumns)
    .eq('user_id', userId)
    .gt('expires_at', nowIso)
    .order('last_activity_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const latest = sanitizeRecord(latestData);
  if (latest) {
    const touched = await touchSession(supabaseAdmin, latest.id);
    return { source: 'latest', session: touched ?? latest };
  }

  const createdId = randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = getExpiresAtIso();

  const { data: createdData, error } = await supabaseAdmin
    .from(getSessionsTable())
    .insert({
      id: createdId,
      user_id: userId,
      chat_messages: [],
      state_snapshot: {},
      last_activity_at: createdAt,
      expires_at: expiresAt,
    })
    .select(selectColumns)
    .single();

  if (error) {
    throw new Error(`Failed to create ai session: ${error.message}`);
  }

  const created = sanitizeRecord(createdData);
  if (!created) {
    throw new Error('Failed to parse created ai session record.');
  }

  return { source: 'created', session: created };
};

export const loadSession = async ({
  supabaseAdmin,
  userId,
  sessionId,
}: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  sessionId: string;
}): Promise<SessionRecord | null> => {
  if (!isValidSessionId(sessionId)) return null;
  const nowIso = new Date().toISOString();
  return getSessionById(supabaseAdmin, userId, sessionId, nowIso);
};

const toPayloadBytes = (candidate: unknown): number =>
  Buffer.byteLength(JSON.stringify(candidate), 'utf-8');

export const enforcePayloadSize = (candidate: unknown): { ok: true } | { ok: false; bytes: number; maxBytes: number } => {
  const bytes = toPayloadBytes(candidate);
  const maxBytes = getAiSessionsMaxPayloadBytes();
  if (bytes > maxBytes) {
    return { ok: false, bytes, maxBytes };
  }
  return { ok: true };
};

const mergeObjects = (
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    const existingValue = merged[key];
    if (isPlainObject(existingValue) && isPlainObject(value)) {
      merged[key] = mergeObjects(existingValue, value);
      continue;
    }
    merged[key] = value;
  }

  return merged;
};

export const mergeStateSnapshots = (
  existing: SessionStateSnapshot,
  patch: SessionStateSnapshot,
): SessionStateSnapshot =>
  mergeObjects(existing as Record<string, unknown>, patch as Record<string, unknown>) as SessionStateSnapshot;

const createSessionIfMissing = async (
  supabaseAdmin: SupabaseClient,
  userId: string,
  sessionId: string,
): Promise<SessionRecord | null> => {
  if (!isValidSessionId(sessionId)) return null;
  const nowIso = new Date().toISOString();
  const expiresAt = getExpiresAtIso();

  const { data, error } = await supabaseAdmin
    .from(getSessionsTable())
    .insert({
      id: sessionId,
      user_id: userId,
      chat_messages: [],
      state_snapshot: {},
      last_activity_at: nowIso,
      expires_at: expiresAt,
    })
    .select(selectColumns)
    .single();

  if (error) return null;
  return sanitizeRecord(data);
};

const updateSession = async ({
  supabaseAdmin,
  session,
  chatMessages,
  stateSnapshot,
}: {
  supabaseAdmin: SupabaseClient;
  session: SessionRecord;
  chatMessages?: unknown[];
  stateSnapshot?: SessionStateSnapshot;
}): Promise<SessionRecord | null> => {
  const nowIso = new Date().toISOString();
  const expiresAt = getExpiresAtIso();

  const nextSnapshot = stateSnapshot
    ? mergeStateSnapshots(session.state_snapshot, stateSnapshot)
    : session.state_snapshot;

  const updatePayload: Record<string, unknown> = {
    last_activity_at: nowIso,
    expires_at: expiresAt,
    state_snapshot: nextSnapshot,
  };

  if (chatMessages) {
    updatePayload.chat_messages = chatMessages;
  }

  const { data, error } = await supabaseAdmin
    .from(getSessionsTable())
    .update(updatePayload)
    .eq('id', session.id)
    .eq('user_id', session.user_id)
    .select(selectColumns)
    .single();

  if (error || !data) return null;
  return sanitizeRecord(data);
};

export const saveSessionTranscript = async ({
  supabaseAdmin,
  userId,
  sessionId,
  chatMessages,
  stateSnapshot,
  createIfMissing = false,
}: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  sessionId: string;
  chatMessages: unknown[];
  stateSnapshot?: SessionStateSnapshot;
  createIfMissing?: boolean;
}): Promise<SessionRecord | null> => {
  const sizeResult = enforcePayloadSize({ chatMessages, stateSnapshot: stateSnapshot ?? {} });
  if (!sizeResult.ok) {
    return null;
  }

  let session = await loadSession({ supabaseAdmin, userId, sessionId });
  if (!session && createIfMissing) {
    session = await createSessionIfMissing(supabaseAdmin, userId, sessionId);
  }
  if (!session) return null;

  return updateSession({
    supabaseAdmin,
    session,
    chatMessages: sanitizeChatMessages(chatMessages),
    stateSnapshot: sanitizeStateSnapshot(stateSnapshot ?? {}),
  });
};

export const saveSessionStateSnapshot = async ({
  supabaseAdmin,
  userId,
  sessionId,
  stateSnapshot,
  createIfMissing = false,
}: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  sessionId: string;
  stateSnapshot: SessionStateSnapshot;
  createIfMissing?: boolean;
}): Promise<SessionRecord | null> => {
  const sizeResult = enforcePayloadSize({ stateSnapshot });
  if (!sizeResult.ok) {
    return null;
  }

  let session = await loadSession({ supabaseAdmin, userId, sessionId });
  if (!session && createIfMissing) {
    session = await createSessionIfMissing(supabaseAdmin, userId, sessionId);
  }
  if (!session) return null;

  return updateSession({
    supabaseAdmin,
    session,
    stateSnapshot: sanitizeStateSnapshot(stateSnapshot),
  });
};

export const loadStateFromSessionSnapshot = async ({
  supabaseAdmin,
  userId,
  sessionId,
}: {
  supabaseAdmin: SupabaseClient;
  userId: string;
  sessionId: string;
}): Promise<ScaffoldState | null> => {
  const session = await loadSession({ supabaseAdmin, userId, sessionId });
  if (!session) return null;

  const storeState = session.state_snapshot?.storeState;
  if (!isPlainObject(storeState)) return null;

  // Minimal structural checks before trusting recovered state.
  if (typeof storeState.planId !== 'string') return null;
  if (!Array.isArray(storeState.terms)) return null;
  if (!Array.isArray(storeState.allCourses)) return null;
  if (!Array.isArray(storeState.phases)) return null;

  return storeState as ScaffoldState;
};

export const buildSessionSnapshotFromStoreState = (
  state: ScaffoldState,
): SessionStateSnapshot => ({
  storeState: state,
  liveJson: {
    plan: state.terms,
    milestones: state.milestones,
  },
  preferences: state.preferences,
});
