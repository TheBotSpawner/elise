-- Schedules ("Programados"), background jobs and scheduled results (docs/architecture/13, 14, 16 §60-66).
-- Product state lives here, not in the background runtime: Trigger.dev only executes.
-- Runs, jobs and results are written by the server (service role) after revalidating
-- ownership; users read them and can only mark results as read.

create table public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  job_type text not null check (job_type in ('schedule.run')),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'waiting', 'waiting_for_approval',
    'completed', 'completed_with_warning', 'failed', 'cancelled'
  )),
  progress_current integer,
  progress_total integer,
  progress_message text,
  runtime_provider text not null default 'trigger.dev',
  -- The runtime's own run id (e.g. Trigger.dev run_…), for tracing and cancellation.
  runtime_job_id text,
  attempts integer not null default 0,
  result_reference jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger background_jobs_updated_at before update on public.background_jobs
  for each row execute function public.set_updated_at();

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by_user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  schedule_type text not null check (schedule_type in ('one_time', 'recurring')),
  status text not null default 'active' check (status in (
    'active', 'paused', 'needs_attention', 'completed', 'archived'
  )),
  -- Canonical IANA timezone: "07:30" means 07:30 there, across DST changes.
  timezone text not null check (char_length(timezone) between 1 and 64),
  -- {"kind":"once","at":"YYYY-MM-DDTHH:mm"} | {"kind":"weekly","days":[1..5],"time":"HH:mm"}
  schedule_definition jsonb not null,
  action_type text not null check (action_type in ('morning_brief')),
  -- Typed per action_type (e.g. Morning Brief blocks and sources), validated by the app.
  configuration jsonb not null default '{}'::jsonb,
  capabilities text[] not null default '{}',
  instructions text check (instructions is null or char_length(instructions) <= 2000),
  delivery_config jsonb not null default '{"notify": "in_app"}'::jsonb,
  -- Schedules follow the same approval policies as interactive actions; never a bypass.
  approval_behavior text not null default 'policy' check (approval_behavior in ('policy')),
  next_run_at timestamptz,
  last_run_at timestamptz,
  runtime_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index schedules_due_idx on public.schedules (next_run_at)
  where status = 'active' and archived_at is null;
create index schedules_workspace_idx on public.schedules (workspace_id, created_at);

create trigger schedules_updated_at before update on public.schedules
  for each row execute function public.set_updated_at();

create table public.schedule_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  schedule_id uuid not null references public.schedules (id) on delete cascade,
  background_job_id uuid references public.background_jobs (id) on delete set null,
  trigger text not null check (trigger in ('scheduled', 'manual')),
  status text not null default 'queued' check (status in (
    'queued', 'running', 'waiting_for_approval',
    'completed', 'completed_with_warning', 'failed', 'cancelled', 'missed', 'skipped'
  )),
  scheduled_for timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  approval_id uuid references public.approvals (id) on delete set null,
  result_id uuid,
  warnings jsonb not null default '[]'::jsonb,
  error_code text,
  error_message text,
  runtime_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- One logical occurrence produces one logical run.
  constraint schedule_runs_occurrence_unique unique (schedule_id, scheduled_for)
);

-- Overlap policy: at most one active run per schedule (a second one is skipped).
create unique index schedule_runs_one_active on public.schedule_runs (schedule_id)
  where status in ('queued', 'running', 'waiting_for_approval');
create index schedule_runs_history_idx on public.schedule_runs (schedule_id, scheduled_for desc);
create index schedule_runs_approval_idx on public.schedule_runs (approval_id) where approval_id is not null;

create table public.scheduled_results (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  schedule_id uuid not null references public.schedules (id) on delete cascade,
  -- A retried run never produces a second result.
  schedule_run_id uuid not null unique references public.schedule_runs (id) on delete cascade,
  result_type text not null check (result_type in ('morning_brief')),
  title text not null,
  content jsonb not null,
  artifact_reference text,
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index scheduled_results_user_idx on public.scheduled_results (user_id, created_at desc);

alter table public.schedule_runs
  add constraint schedule_runs_result_fk foreign key (result_id)
  references public.scheduled_results (id) on delete set null;

-- A run notifies at most once per type, however many times it is retried.
create unique index notifications_schedule_run_once on public.notifications (source_id, notification_type)
  where source_type = 'schedule_run';

alter table public.background_jobs enable row level security;
alter table public.schedules enable row level security;
alter table public.schedule_runs enable row level security;
alter table public.scheduled_results enable row level security;

create policy "Users read their schedules" on public.schedules
  for select to authenticated
  using (created_by_user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users create their schedules" on public.schedules
  for insert to authenticated
  with check (created_by_user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users change their schedules" on public.schedules
  for update to authenticated
  using (created_by_user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (created_by_user_id = auth.uid() and public.is_workspace_member(workspace_id));
-- No DELETE: deleting archives the schedule and keeps its history.

create policy "Users read their schedule runs" on public.schedule_runs
  for select to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.schedules s
      where s.id = schedule_id and s.created_by_user_id = auth.uid()
    )
  );

create policy "Users read their background jobs" on public.background_jobs
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "Users read their results" on public.scheduled_results
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users mark their results read" on public.scheduled_results
  for update to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- API users may only read runs/jobs/results and set read_at; everything else is server-side.
revoke insert, update, delete on public.schedule_runs, public.background_jobs from anon, authenticated;
revoke insert, update, delete on public.scheduled_results from anon, authenticated;
grant update (read_at) on public.scheduled_results to authenticated;
revoke all on public.schedules from anon;

alter publication supabase_realtime add table
  public.schedules, public.schedule_runs, public.scheduled_results, public.background_jobs;

-- Proposing a Schedule from chat is an ELISE-internal capability (no provider, read-only).
insert into public.capability_definitions (key, display_name, status)
values ('schedules', 'Schedules', 'available');
