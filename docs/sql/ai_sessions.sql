-- AI sessions persistence for grad-planner-agent
-- PostgreSQL / Supabase migration

create table if not exists public.ai_sessions (
  id uuid primary key,
  user_id text not null,
  chat_messages jsonb not null default '[]'::jsonb,
  state_snapshot jsonb not null default '{}'::jsonb,
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_sessions_chat_messages_is_array
    check (jsonb_typeof(chat_messages) = 'array'),
  constraint ai_sessions_expires_after_created
    check (expires_at > created_at)
);

create index if not exists ai_sessions_user_last_activity_idx
  on public.ai_sessions (user_id, last_activity_at desc);

create or replace function public.set_updated_at_ai_sessions()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at_ai_sessions on public.ai_sessions;
create trigger set_updated_at_ai_sessions
before update on public.ai_sessions
for each row
execute function public.set_updated_at_ai_sessions();

-- Optional cleanup policy for expired sessions (example for pg_cron):
-- select cron.schedule(
--   'cleanup-ai-sessions-daily',
--   '0 3 * * *',
--   $$delete from public.ai_sessions where expires_at < now();$$
-- );
