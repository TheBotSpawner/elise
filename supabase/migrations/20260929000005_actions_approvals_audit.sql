-- Actions (concrete tool executions that write), tool execution traces, approvals,
-- notifications and the audit trail.

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  ai_run_id uuid references public.ai_runs (id) on delete set null,
  tool_name text not null,
  capability_key text not null references public.capability_definitions (key),
  operation text not null,
  provider_key text references public.provider_definitions (key),
  connection_id uuid references public.provider_connections (id) on delete set null,
  target_type text,
  target_id text,
  risk_level text not null check (risk_level in ('low', 'medium', 'high', 'critical')),
  origin text not null check (origin in ('ai', 'user_ui', 'schedule', 'system')),
  status text not null default 'proposed' check (status in (
    'proposed', 'waiting_for_clarification', 'waiting_for_approval', 'executing',
    'completed', 'failed', 'cancelled', 'expired', 'unknown_outcome'
  )),
  -- Immutable: an approval refers to exactly this payload.
  input_snapshot jsonb not null,
  input_hash text not null,
  idempotency_key text,
  result_reference jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create index actions_workspace_recent_idx on public.actions (workspace_id, created_at desc);

create table public.tool_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  action_id uuid references public.actions (id) on delete set null,
  ai_run_id uuid references public.ai_runs (id) on delete set null,
  tool_name text not null,
  provider_key text,
  connection_id uuid,
  status text not null check (status in ('succeeded', 'failed', 'approval_required', 'clarification_required', 'rejected')),
  latency_ms integer,
  error_code text,
  result_metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz not null,
  completed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index tool_executions_run_idx on public.tool_executions (ai_run_id);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  action_id uuid not null references public.actions (id) on delete cascade,
  capability_key text not null references public.capability_definitions (key),
  operation text not null,
  provider_key text,
  connection_id uuid,
  risk_level text not null check (risk_level in ('low', 'medium', 'high', 'critical')),
  payload_snapshot jsonb not null,
  payload_hash text not null,
  summary text not null,
  reason text not null,
  status text not null default 'pending' check (status in (
    'pending', 'approved', 'rejected', 'expired', 'cancelled', 'superseded'
  )),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_user_id uuid references auth.users (id) on delete set null,
  constraint approvals_resolution_consistent check ((status = 'pending') = (resolved_at is null))
);

create index approvals_pending_idx on public.approvals (workspace_id, created_at desc) where status = 'pending';

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  notification_type text not null,
  title text not null,
  content text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  source_type text,
  source_id text,
  action_url text check (action_url is null or action_url like '/%'),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index notifications_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;

-- Durable history of meaningful actions. Append-only from the application.
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  event_type text not null,
  resource_type text,
  resource_id text,
  action_id uuid,
  provider_key text,
  connection_id uuid,
  approval_id uuid,
  origin text not null check (origin in ('ai', 'user_ui', 'schedule', 'system')),
  result text not null check (result in ('success', 'failure', 'pending')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_workspace_recent_idx on public.audit_events (workspace_id, created_at desc);

create trigger actions_updated_at before update on public.actions
  for each row execute function public.set_updated_at();

-- The approved payload can never change underneath an approval.
create or replace function public.prevent_action_payload_change()
returns trigger
language plpgsql
as $$
begin
  if new.input_snapshot is distinct from old.input_snapshot or new.input_hash is distinct from old.input_hash then
    raise exception 'action payload is immutable; create a new action instead';
  end if;
  return new;
end;
$$;

create trigger actions_payload_immutable before update on public.actions
  for each row execute function public.prevent_action_payload_change();

alter table public.actions enable row level security;
alter table public.tool_executions enable row level security;
alter table public.approvals enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_events enable row level security;

create policy "Users read their actions" on public.actions
  for select to authenticated using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users record their actions" on public.actions
  for insert to authenticated with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users update their actions" on public.actions
  for update to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "Users read their tool executions" on public.tool_executions
  for select to authenticated using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users record their tool executions" on public.tool_executions
  for insert to authenticated with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "Users read their approvals" on public.approvals
  for select to authenticated using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users request approvals for their actions" on public.approvals
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.actions a
      where a.id = action_id and a.workspace_id = approvals.workspace_id and a.user_id = auth.uid()
    )
  );
-- Only pending approvals can be resolved, and only into a terminal state (no Approved -> Pending).
create policy "Users resolve pending approvals" on public.approvals
  for update to authenticated
  using (user_id = auth.uid() and status = 'pending' and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and status <> 'pending' and public.is_workspace_member(workspace_id));

create policy "Users read their notifications" on public.notifications
  for select to authenticated using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users create their notifications" on public.notifications
  for insert to authenticated with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users mark their notifications" on public.notifications
  for update to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));

create policy "Members read workspace audit" on public.audit_events
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Users append their audit events" on public.audit_events
  for insert to authenticated with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));
-- No UPDATE/DELETE policies: audit history is immutable from the application.

alter publication supabase_realtime add table public.approvals, public.notifications;
