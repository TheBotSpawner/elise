-- MVP productization (ADR-019): onboarding for existing accounts, usage observability, and
-- tighter grants on connection tables. Additive only; nothing is dropped or deleted.

-- 1. Existing accounts are not sent through the new first-run onboarding. Anyone created before
--    this migration who never finished it is treated as onboarded; the welcome stays reachable
--    from Settings. New accounts keep the 'pending' default from the core tenancy migration.
update public.user_profiles
set onboarding_status = 'completed'
where onboarding_status = 'pending';

-- 2. Usage events: one row per paid call (model, embedding, speech, web), for cost and latency
--    visibility. Metadata only: never prompts, transcripts, documents or replies. Written by the
--    server (service role); members can read their own workspace's rows.
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  feature text not null check (char_length(feature) between 1 and 40),
  operation text not null check (
    operation in ('llm', 'embedding', 'transcription', 'speech', 'web_search', 'web_fetch')
  ),
  provider text not null check (char_length(provider) between 1 and 40),
  model text check (char_length(model) <= 80),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  cached_tokens integer check (cached_tokens >= 0),
  reasoning_tokens integer check (reasoning_tokens >= 0),
  -- Non-token usage: seconds of audio, characters spoken, queries.
  units numeric(14, 3) check (units >= 0),
  unit text check (unit in ('seconds', 'characters', 'queries', 'pages')),
  latency_ms integer check (latency_ms >= 0),
  estimated_cost_usd numeric(14, 6) check (estimated_cost_usd >= 0),
  status text not null default 'succeeded' check (status in ('succeeded', 'failed')),
  ai_run_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_workspace_created_idx
  on public.usage_events (workspace_id, created_at desc);
create index if not exists usage_events_created_idx on public.usage_events (created_at desc);

alter table public.usage_events enable row level security;

drop policy if exists "Members read their workspace's usage" on public.usage_events;
create policy "Members read their workspace's usage" on public.usage_events
  for select to authenticated using (public.is_workspace_member(workspace_id));

revoke insert, update, delete on public.usage_events from authenticated;
revoke all on public.usage_events from anon;

-- 3. Connection capabilities and bindings are changed in place (enable, default, disconnect),
--    never deleted from the browser: a deleted row would silently drop a provider binding.
revoke delete on public.connection_capabilities from authenticated;
revoke delete on public.capability_bindings from authenticated;

-- 4. Deleting an account deletes its personal workspace (and, through the existing cascades,
--    everything in it). Before this, workspaces.owner_user_id blocked deleting the auth user,
--    so an account could not be removed at all. Team workspaces are left alone: the foreign
--    key still refuses to orphan them, so ownership must be transferred first.
create or replace function public.delete_personal_workspaces()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.workspaces where owner_user_id = old.id and type = 'personal';
  return old;
end;
$$;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  before delete on auth.users
  for each row execute function public.delete_personal_workspaces();
