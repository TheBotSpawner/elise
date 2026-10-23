-- ADR-115: recurring tasks. A series is ELISE's own layer over any task provider (ELISE Native,
-- Google Tasks), like labels and priority (ADR-050): the provider holds one live occurrence (a
-- normal task); this row holds the rule and what the next occurrence copies. Completing the live
-- occurrence creates the next one — never a batch of future tasks.
--
-- Idempotent: safe to re-run (if not exists / drop policy if exists). Rollback:
--   drop table if exists public.task_recurrences;
-- Nothing else depends on it; tasks already created stay as ordinary tasks.

create table if not exists public.task_recurrences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  provider_key text not null check (char_length(provider_key) <= 40),
  connection_id uuid not null references public.provider_connections (id) on delete cascade,
  provider_list_id text not null default '' check (char_length(provider_list_id) <= 300),
  -- The live occurrence at the provider ("pending:<date>" while the next one is being created).
  current_task_id text not null check (char_length(current_task_id) <= 300),
  -- RFC 5545 subset without DTSTART (core/tasks/recurrence.ts); dtstart is the series' anchor.
  rrule text not null check (char_length(rrule) <= 300),
  dtstart date not null,
  -- The rule's date of the live occurrence (the task's due date may have been moved by hand).
  occurrence_date date not null,
  occurrences integer not null default 1 check (occurrences >= 1),
  timezone text not null check (char_length(timezone) <= 64),
  -- What the next occurrence copies: title, description, priority, labels. Data, not a task.
  template jsonb not null default '{}'::jsonb check (pg_column_size(template) <= 16000),
  status text not null default 'active' check (status in ('active', 'ended')),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active series per live task: a second completion can't fork it.
create unique index if not exists task_recurrences_live_idx
  on public.task_recurrences (workspace_id, connection_id, current_task_id)
  where status = 'active';
create index if not exists task_recurrences_ws_idx
  on public.task_recurrences (workspace_id, status);

drop trigger if exists task_recurrences_updated_at on public.task_recurrences;
create trigger task_recurrences_updated_at before update on public.task_recurrences
  for each row execute function public.set_updated_at();

alter table public.task_recurrences enable row level security;

drop policy if exists "Members manage task recurrences" on public.task_recurrences;
create policy "Members manage task recurrences" on public.task_recurrences
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.provider_connections c
       where c.id = connection_id and c.workspace_id = task_recurrences.workspace_id
    )
  );
