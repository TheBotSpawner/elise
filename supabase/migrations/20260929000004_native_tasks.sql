-- ELISE Tasks (Native). Supabase is the source of truth for these rows.
-- Deletion is soft (archived_at) so history, audit and undo remain possible.

create table public.task_lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_list_id uuid references public.task_lists (id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 500),
  description text check (char_length(description) <= 5000),
  notes text check (char_length(notes) <= 5000),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  priority text check (priority in ('low', 'medium', 'high')),
  category text check (char_length(category) <= 80),
  -- Calendar date in the user's timezone (tasks are day-level, like most task providers).
  due_date date,
  completed_at timestamptz,
  created_by_user_id uuid references auth.users (id) on delete set null,
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint tasks_completed_at_matches_status check ((status = 'completed') = (completed_at is not null))
);

create index tasks_open_idx on public.tasks (workspace_id, status, due_date) where archived_at is null;
create index tasks_created_idx on public.tasks (workspace_id, created_at desc) where archived_at is null;

create trigger task_lists_updated_at before update on public.task_lists
  for each row execute function public.set_updated_at();
create trigger tasks_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

alter table public.task_lists enable row level security;
alter table public.tasks enable row level security;

create policy "Members manage task lists" on public.task_lists
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "Members read tasks" on public.tasks
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members create tasks" on public.tasks
  for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and (task_list_id is null or exists (
      select 1 from public.task_lists l where l.id = task_list_id and l.workspace_id = tasks.workspace_id
    ))
  );
create policy "Members update tasks" on public.tasks
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (
    public.is_workspace_member(workspace_id)
    and (task_list_id is null or exists (
      select 1 from public.task_lists l where l.id = task_list_id and l.workspace_id = tasks.workspace_id
    ))
  );
-- No DELETE policy: tasks are archived, never physically deleted from the client.

alter publication supabase_realtime add table public.tasks;
