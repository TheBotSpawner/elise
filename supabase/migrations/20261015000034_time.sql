-- Native Time (ADR-045): timers, Pomodoros and stopwatches are the user's own ELISE entities.
-- A conversation may create one (provenance), but never owns it: leaving or deleting the
-- conversation leaves the timer running. Time is stored as timestamps (ends_at), never as a
-- countdown; `version` goes up on every change so a stale scheduled completion can't apply.

insert into public.capability_definitions (key, display_name, status) values
  ('time', 'Time', 'available')
on conflict (key) do update set status = 'available';

create table public.timers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('timer', 'pomodoro', 'stopwatch')),
  label text check (label is null or char_length(btrim(label)) between 1 and 80),
  state text not null check (state in ('running', 'paused', 'completed', 'cancelled')),
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  started_at timestamptz,
  ends_at timestamptz,
  remaining_ms bigint check (remaining_ms is null or remaining_ms >= 0),
  elapsed_ms bigint not null default 0 check (elapsed_ms >= 0),
  laps bigint[] not null default '{}' check (cardinality(laps) <= 99),
  pomodoro jsonb check (pomodoro is null or octet_length(pomodoro::text) <= 1000),
  version integer not null default 1 check (version >= 1),
  completed_at timestamptz,
  -- Provenance only (no foreign keys: deleting a conversation never touches its timers).
  created_from_conversation_id uuid,
  created_from_session_id uuid,
  created_from_schedule_id uuid,
  created_from_space_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state <> 'running' or kind = 'stopwatch' or ends_at is not null),
  check ((kind = 'pomodoro') = (pomodoro is not null))
);

create index timers_active_idx on public.timers (user_id, workspace_id)
  where state in ('running', 'paused');
create index timers_recent_idx on public.timers (user_id, workspace_id, updated_at desc);

create trigger timers_updated_at before update on public.timers
  for each row execute function public.set_updated_at();

-- A timer never moves between users or workspaces.
create or replace function public.timers_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id <> old.workspace_id or new.user_id <> old.user_id or new.kind <> old.kind then
    raise exception 'a timer cannot change owner or kind';
  end if;
  return new;
end;
$$;

create trigger timers_before_update before update on public.timers
  for each row execute function public.timers_before_update();

alter table public.timers enable row level security;

-- Timers are personal: only their owner, inside a workspace they belong to.
create policy "Users read their timers" on public.timers for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Users add their timers" on public.timers for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Users change their timers" on public.timers for update to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));

-- One completion notification per timer version, whoever noticed it first.
create unique index notifications_timer_once on public.notifications (source_id, notification_type)
  where source_type = 'timer';

-- Other tabs and devices follow state changes (never a per-second update: there are none).
alter publication supabase_realtime add table public.timers;
