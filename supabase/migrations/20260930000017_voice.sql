-- Voice Foundation (ADR-014). Voice is another way into the same ELISE: a voice interaction is
-- an interaction session (modality 'voice') whose turns live in interaction_turns — no History
-- thread — with its own Live Workspace. Raw audio is never stored.

-- ── Voice preferences (allowlisted) ──────────────────────────────────────────
alter table public.user_profiles
  add column voice_enabled boolean not null default true,
  add column voice_output boolean not null default true,
  add column voice_language text not null default 'auto'
    check (voice_language in ('auto', 'es', 'en')),
  add column voice_name text not null default 'marin'
    check (voice_name in ('marin', 'cedar', 'coral', 'sage', 'ash', 'verse'));

-- ── A Live Workspace belongs to a conversation or to a voice session ─────────
alter table public.live_workspaces
  alter column conversation_id drop not null,
  add column session_id uuid unique references public.interaction_sessions (id) on delete cascade,
  add constraint live_workspaces_one_thread check ((conversation_id is null) <> (session_id is null));

create or replace function public.check_live_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.conversation_id is not null and not exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.workspace_id = new.workspace_id and c.user_id = new.user_id
  ) then
    raise exception 'conversation must belong to the same workspace and user';
  end if;
  if new.session_id is not null and not exists (
    select 1 from public.interaction_sessions s
    where s.id = new.session_id and s.workspace_id = new.workspace_id and s.user_id = new.user_id
      and s.status = 'active'
  ) then
    raise exception 'session must belong to the same workspace and user';
  end if;
  return new;
end;
$$;

-- ── Runs of a voice session are traced to it ─────────────────────────────────
alter table public.ai_runs
  add column interaction_session_id uuid references public.interaction_sessions (id) on delete set null;

create index interaction_sessions_voice_idx
  on public.interaction_sessions (workspace_id, user_id, last_activity_at desc)
  where conversation_id is null and status = 'active';

-- Deleting (archiving) a voice session forgets it everywhere: transcripts, Recall, workspace.
create or replace function public.forget_archived_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'archived' and old.status <> 'archived' and new.conversation_id is null then
    delete from public.interaction_turns where session_id = new.id;
    delete from public.recall_chunks where session_id = new.id;
    delete from public.live_workspaces where session_id = new.id;
    new.summary := null;
    new.topics := '{}';
    new.title := null;
    new.indexed_through := null;
  end if;
  return new;
end;
$$;

create trigger interaction_sessions_forget before update of status on public.interaction_sessions
  for each row execute function public.forget_archived_session();
