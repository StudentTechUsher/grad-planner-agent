import crypto from 'crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

const AGENT_SESSION_COOKIE_NAME = 'agent_session';
const DEFAULT_HANDOFF_ISSUER = 'stuplanning-app';
const DEFAULT_HANDOFF_AUDIENCE = 'grad-planner-agent';
const DEFAULT_RELAUNCH_URL = 'https://app.stuplanning.com/grad-plan';
const DEFAULT_SESSION_IDLE_TTL_SECONDS = 15 * 60;
const DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS = 90 * 60;

export interface AgentBootstrapPayload {
  user?: {
    id?: string;
    email?: string;
  };
  preferences?: Record<string, unknown>;
  transcriptCourses?: Array<Record<string, unknown>>;
  transcriptSummary?: string;
  priorPlanMeta?: Record<string, unknown>;
}

export interface AgentSessionPayload {
  userId: string;
  handoffId: string;
  email?: string;
  iat: number;
  exp: number;
  absExp: number;
}

interface JwtPayload {
  [key: string]: unknown;
  iat?: number;
  exp?: number;
  abs_exp?: number;
  iss?: string;
  aud?: string;
  sub?: string;
  jti?: string;
}

type AgentSessionSeed = {
  userId: string;
  handoffId: string;
  email?: string;
  iat?: number;
  absExp?: number;
};

export interface VerifiedHandoffClaims {
  issuer: string;
  audience: string;
  userId: string;
  handoffId: string;
  iat: number;
  exp: number;
  email?: string;
}

const base64UrlEncode = (input: Buffer | string): string =>
  Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const base64UrlDecode = (input: string): Buffer => {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  const base64 = remainder === 0 ? padded : `${padded}${'='.repeat(4 - remainder)}`;
  return Buffer.from(base64, 'base64');
};

const timingSafeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

const signHs256 = (data: string, secret: string): string =>
  base64UrlEncode(crypto.createHmac('sha256', secret).update(data).digest());

const decodeJwtPayload = (token: string): { header: Record<string, unknown>; payload: JwtPayload; signature: string; signingInput: string } | null => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  try {
    const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf-8')) as Record<string, unknown>;
    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf-8')) as JwtPayload;
    return {
      header,
      payload,
      signature: encodedSignature,
      signingInput: `${encodedHeader}.${encodedPayload}`,
    };
  } catch {
    return null;
  }
};

const verifyJwtHs256 = (token: string, secret: string): JwtPayload | null => {
  const decoded = decodeJwtPayload(token);
  if (!decoded) return null;

  if (decoded.header.alg !== 'HS256') return null;
  if (typeof decoded.header.typ === 'string' && decoded.header.typ !== 'JWT') return null;

  const expectedSignature = signHs256(decoded.signingInput, secret);
  if (!timingSafeEqual(expectedSignature, decoded.signature)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof decoded.payload.exp !== 'number' || decoded.payload.exp <= now) return null;

  return decoded.payload;
};

const parseCookieHeader = (cookieHeader: string | null): Record<string, string> => {
  if (!cookieHeader) return {};

  return cookieHeader
    .split(';')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, segment) => {
      const eqIndex = segment.indexOf('=');
      if (eqIndex <= 0) return acc;
      const key = decodeURIComponent(segment.slice(0, eqIndex).trim());
      const value = decodeURIComponent(segment.slice(eqIndex + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
};

const getSessionSecret = (): string =>
  process.env.AGENT_SESSION_SECRET || process.env.GRAD_PLANNER_HANDOFF_SECRET || 'dev-only-agent-session-secret';

const getHandoffSecret = (): string => {
  const secret = process.env.GRAD_PLANNER_HANDOFF_SECRET;
  if (!secret) {
    throw new Error('GRAD_PLANNER_HANDOFF_SECRET is required to verify handoff tokens.');
  }
  return secret;
};

const getSessionIdleTtlSeconds = (): number => {
  const parsed = Number(process.env.AGENT_SESSION_IDLE_TTL_SECONDS ?? DEFAULT_SESSION_IDLE_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_IDLE_TTL_SECONDS;
  return Math.floor(parsed);
};

const getSessionAbsoluteTtlSeconds = (): number => {
  const parsed = Number(process.env.AGENT_SESSION_ABSOLUTE_TTL_SECONDS ?? DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS;
  return Math.floor(parsed);
};

const shouldUseSecureCookie = (): boolean => {
  if (process.env.AGENT_COOKIE_SECURE === 'false') return false;
  return process.env.NODE_ENV !== 'development';
};

export const getAgentRelaunchUrl = (reason?: string): string => {
  const baseUrl = process.env.AGENT_RELAUNCH_URL || DEFAULT_RELAUNCH_URL;
  if (!reason) return baseUrl;

  try {
    const url = new URL(baseUrl);
    url.searchParams.set('reason', reason);
    return url.toString();
  } catch {
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}reason=${encodeURIComponent(reason)}`;
  }
};

const buildAgentSessionToken = (payload: AgentSessionSeed): { token: string; exp: number } => {
  const now = Math.floor(Date.now() / 1000);
  const iat = typeof payload.iat === 'number' ? payload.iat : now;
  const absExp = typeof payload.absExp === 'number' ? payload.absExp : iat + getSessionAbsoluteTtlSeconds();
  const idleExp = now + getSessionIdleTtlSeconds();
  const exp = Math.min(absExp, idleExp);

  const header = { alg: 'HS256', typ: 'JWT' };
  const body: JwtPayload = {
    sub: payload.userId,
    jti: payload.handoffId,
    email: payload.email,
    iat,
    exp,
    abs_exp: absExp,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = signHs256(signingInput, getSessionSecret());

  return {
    token: `${signingInput}.${signature}`,
    exp,
  };
};

export const createAgentSessionToken = (payload: AgentSessionSeed): string =>
  buildAgentSessionToken(payload).token;

export const verifyAgentSessionToken = (token: string): AgentSessionPayload | null => {
  const payload = verifyJwtHs256(token, getSessionSecret());
  if (!payload) return null;

  if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const absExp = typeof payload.abs_exp === 'number' ? payload.abs_exp : payload.exp;
  if (absExp <= now) return null;

  return {
    userId: payload.sub,
    handoffId: payload.jti,
    email: typeof payload.email === 'string' ? payload.email : undefined,
    iat: payload.iat,
    exp: payload.exp,
    absExp,
  };
};

export const verifyHandoffToken = (token: string): VerifiedHandoffClaims | null => {
  const payload = verifyJwtHs256(token, getHandoffSecret());
  if (!payload) return null;

  const expectedIssuer = process.env.GRAD_PLANNER_HANDOFF_ISSUER || DEFAULT_HANDOFF_ISSUER;
  const expectedAudience = process.env.GRAD_PLANNER_HANDOFF_AUDIENCE || DEFAULT_HANDOFF_AUDIENCE;

  if (payload.iss !== expectedIssuer || payload.aud !== expectedAudience) return null;
  if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    return null;
  }

  return {
    issuer: expectedIssuer,
    audience: expectedAudience,
    userId: payload.sub,
    handoffId: payload.jti,
    iat: payload.iat,
    exp: payload.exp,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
};

const serializeSessionCookie = (token: string, maxAgeSeconds: number): string => {
  const secure = shouldUseSecureCookie() ? '; Secure' : '';
  const expires = new Date(Date.now() + maxAgeSeconds * 1000).toUTCString();
  return `${encodeURIComponent(AGENT_SESSION_COOKIE_NAME)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAgeSeconds}; Expires=${expires}`;
};

const setAgentSessionCookieOnResponse = (response: Response, session: AgentSessionSeed): void => {
  const now = Math.floor(Date.now() / 1000);
  const signed = buildAgentSessionToken(session);
  const maxAge = Math.max(1, signed.exp - now);
  response.headers.append('set-cookie', serializeSessionCookie(signed.token, maxAge));
};

export const setAgentSessionCookie = (response: NextResponse, session: AgentSessionSeed): void => {
  const now = Math.floor(Date.now() / 1000);
  const signed = buildAgentSessionToken(session);
  const maxAge = Math.max(1, signed.exp - now);
  response.cookies.set(AGENT_SESSION_COOKIE_NAME, signed.token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    path: '/',
    maxAge,
  });
};

export const clearAgentSessionCookie = (response: NextResponse): void => {
  response.cookies.set(AGENT_SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'lax',
    path: '/',
    expires: new Date(0),
  });
};

export const withRefreshedAgentSession = <T extends Response>(
  response: T,
  session: AgentSessionPayload,
): T => {
  setAgentSessionCookieOnResponse(response, {
    userId: session.userId,
    handoffId: session.handoffId,
    email: session.email,
    iat: session.iat,
    absExp: session.absExp,
  });
  return response;
};

export const getAgentSessionFromRequest = async (req: Request): Promise<AgentSessionPayload | null> => {
  const cookieHeader = req.headers.get('cookie');
  const parsedCookies = parseCookieHeader(cookieHeader);
  const token = parsedCookies[AGENT_SESSION_COOKIE_NAME];
  if (!token) return null;
  return verifyAgentSessionToken(token);
};

export const getAgentSessionFromCookieStore = async (): Promise<AgentSessionPayload | null> => {
  const cookieStore = await cookies();
  const token = cookieStore.get(AGENT_SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyAgentSessionToken(token);
};

export const getAgentSessionCookieName = (): string => AGENT_SESSION_COOKIE_NAME;
