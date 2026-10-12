-- ADR-050: Tasks Workspace — subtasks, labels and ELISE-only enrichment of provider tasks.
-- Additive only: no task, list, id, due date or completion state is rewritten. Google Tasks are
-- never copied here; an enrichment row holds only what Google can't (ELISE priority, labels),
-- keyed to the provider task's identity.

-- Native subtasks. A parent is a task of the same workspace (checked below).
alter table public.tasks
  add column parent_task_id uuid references public.tasks (id) on delete set null;
create index tasks_parent_idx on public.tasks (parent_task_id)
  where parent_task_id is not null and archived_at is null;

create or replace function public.check_task_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.parent_task_id is not null then
    if new.parent_task_id = new.id then
      raise exception 'A task cannot be its own parent' using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.tasks p
       where p.id = new.parent_task_id and p.workspace_id = new.workspace_id
    ) then
      raise exception 'The parent task belongs to another workspace' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger tasks_parent_check before insert or update of parent_task_id on public.tasks
  for each row execute function public.check_task_parent();

-- Labels: one workspace-scoped label system (Tasks now; other domains add their own target
-- column to label_assignments). Normalized, never comma-separated text.
create table public.labels (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index labels_name_idx on public.labels (workspace_id, lower(btrim(name)));

-- ELISE-only metadata for a task another provider owns. Identity is the provider's; nothing the
-- provider stores (title, status, due, notes, parent, list) is duplicated here.
create table public.task_enrichments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider_key text not null check (provider_key <> 'elise_native'),
  connection_id uuid not null references public.provider_connections (id) on delete cascade,
  provider_list_id text not null check (char_length(provider_list_id) <= 300),
  provider_task_id text not null check (char_length(provider_task_id) <= 300),
  priority text check (priority in ('low', 'medium', 'high')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index task_enrichments_identity_idx
  on public.task_enrichments (workspace_id, connection_id, provider_task_id);

-- A label on a native task or on an enriched provider task (exactly one of the two).
create table public.label_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  label_id uuid not null references public.labels (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete cascade,
  enrichment_id uuid references public.task_enrichments (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint label_target check (num_nonnulls(task_id, enrichment_id) = 1)
);
create unique index label_assignments_task_idx
  on public.label_assignments (label_id, task_id) where task_id is not null;
create unique index label_assignments_enrichment_idx
  on public.label_assignments (label_id, enrichment_id) where enrichment_id is not null;
create index label_assignments_ws_idx on public.label_assignments (workspace_id);

create trigger labels_updated_at before update on public.labels
  for each row execute function public.set_updated_at();
create trigger task_enrichments_updated_at before update on public.task_enrichments
  for each row execute function public.set_updated_at();

alter table public.labels enable row level security;
alter table public.task_enrichments enable row level security;
alter table public.label_assignments enable row level security;

create policy "Members manage task labels" on public.labels
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "Members manage task enrichments" on public.task_enrichments
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.provider_connections c
       where c.id = connection_id and c.workspace_id = task_enrichments.workspace_id
    )
  );

-- Every reference stays inside the same workspace (no cross-tenant label or task).
create policy "Members manage task label assignments" on public.label_assignments
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.labels l
       where l.id = label_id and l.workspace_id = label_assignments.workspace_id
    )
    and (task_id is null or exists (
      select 1 from public.tasks t
       where t.id = task_id and t.workspace_id = label_assignments.workspace_id
    ))
    and (enrichment_id is null or exists (
      select 1 from public.task_enrichments e
       where e.id = enrichment_id and e.workspace_id = label_assignments.workspace_id
    ))
  );

alter publication supabase_realtime add table public.labels;
alter publication supabase_realtime add table public.task_enrichments;
alter publication supabase_realtime add table public.label_assignments;
