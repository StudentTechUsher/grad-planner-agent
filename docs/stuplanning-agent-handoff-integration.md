# Stuplanning -> Grad Planner Agent Handoff Integration

This document is for the coding agent working in the `app.stuplanning.com` codebase.

## Goal
When a user starts a new grad plan from stuplanning, redirect them into the agent app with a one-time handoff token. The agent app consumes the token, creates its own secure session cookie, and starts with preloaded user context.

## Launch Endpoint To Build (stuplanning app)
Create `POST /api/grad-plan-agent/launch` (server-side only):

1. Verify the current Supabase session user (e.g., via `getVerifiedUser`).
2. Build `bootstrap_payload` from user-scoped data:
- preferences
- transcript courses/summary
- prior active plan metadata (if present)
3. Insert one row into `agent_handoffs`:
- `id` (uuid)
- `user_id`
- `bootstrap_payload` (jsonb)
- `expires_at` (`now() + 60 seconds`)
- `used_at = null`
4. Sign HS256 JWT with claims:
- `iss = stuplanning-app` (or configured issuer)
- `aud = grad-planner-agent` (or configured audience)
- `sub = <user_id>`
- `jti = <agent_handoffs.id>`
- `iat`, `exp`
5. Redirect to:
- `${GRAD_PLANNER_AGENT_URL}/auth/handoff?token=<jwt>`

## Required Environment Variables (stuplanning)
- `GRAD_PLANNER_AGENT_URL`
- `GRAD_PLANNER_HANDOFF_SECRET`
- `GRAD_PLANNER_HANDOFF_ISSUER` (default: `stuplanning-app`)
- `GRAD_PLANNER_HANDOFF_AUDIENCE` (default: `grad-planner-agent`)
- `GRAD_PLANNER_HANDOFF_TTL_SECONDS` (recommended: `60`)

## agent_handoffs Table Contract
Expected by agent app:
- `id` uuid primary key
- `user_id` text/uuid
- `bootstrap_payload` jsonb
- `expires_at` timestamptz
- `used_at` timestamptz null
- `created_at` timestamptz default now()

## Security Requirements
- Make handoff token single-use by consuming only rows where `used_at is null`.
- Enforce short expiration (60 seconds).
- Never log raw JWTs or transcript payloads.
- Keep launch endpoint server-only (no client-side JWT creation).

## Suggested Client Wiring (stuplanning)
- Replace “New Grad Plan” click action to hit `POST /api/grad-plan-agent/launch`.
- Follow server redirect directly; do not proxy token through frontend code.
- Expose a browser-friendly relaunch page URL (for expired sessions) that triggers this launch flow.

## Notes
- Agent app now protects all interaction endpoints behind its own `agent_session` cookie.
- If handoff fails/expired, user should be sent back to stuplanning launch.
