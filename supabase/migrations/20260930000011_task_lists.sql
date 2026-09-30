-- Native Task Lists (ADR-009): every workspace has a default "Inbox"; a native task belongs to
-- one list. Google Tasks lists stay at Google (read live per connection), nothing is copied.
-- Non-destructive: existing tasks keep their ids and move into their workspace's Inbox.

alter table public.task_lists add column is_default boolean not null default false;
alter table public.task_lists add constraint task_lists_name_trimmed check (char_length(btrim(name)) between 1 and 120);

create unique index task_lists_default_idx on public.task_lists (workspace_id)
  where is_default and status = 'active';
create unique index task_lists_name_idx on public.task_lists (workspace_id, lower(name))
  where status = 'active';

create or replace function public.provision_task_inbox()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.task_lists (workspace_id, name, is_default) values (new.id, 'Inbox', true);
  return new;
end;
$$;

create trigger workspaces_task_inbox after insert on public.workspaces
  for each row execute function public.provision_task_inbox();

-- Existing workspaces: an Inbox (unless a default already exists) …
insert into public.task_lists (workspace_id, name, is_default)
select w.id, 'Inbox', true
from public.workspaces w
where not exists (
  select 1 from public.task_lists l where l.workspace_id = w.id and l.is_default and l.status = 'active'
)
  and not exists (
  select 1 from public.task_lists l where l.workspace_id = w.id and lower(l.name) = 'inbox' and l.status = 'active'
);
update public.task_lists l set is_default = true
where lower(l.name) = 'inbox' and l.status = 'active'
  and not exists (
    select 1 from public.task_lists d where d.workspace_id = l.workspace_id and d.is_default and d.status = 'active'
  );

-- … and every task without a list goes into it.
update public.tasks t set task_list_id = l.id
from public.task_lists l
where t.task_list_id is null and l.workspace_id = t.workspace_id and l.is_default and l.status = 'active';

-- Lists are archived, never deleted from the client (a task's list must not vanish).
revoke delete on public.task_lists from anon, authenticated;
alter publication supabase_realtime add table public.task_lists;
