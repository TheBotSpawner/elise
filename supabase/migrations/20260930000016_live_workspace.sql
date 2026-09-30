-- Live Workspace (ADR-013): the visual working context of one interaction. Ephemeral: one row
-- per conversation, overwritten as it changes, expiring 12 h after its last change, deleted
-- with its conversation. Surfaces are small validated snapshots that point to real resources.

insert into public.capability_definitions (key, display_name, status) values
  ('workspace', 'Live Workspace', 'available')
on conflict (key) do update set status = 'available';

create table public.live_workspaces (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null unique references public.conversations (id) on delete cascade,
  intent jsonb,
  surfaces jsonb not null default '[]'::jsonb,
  focus_id text,
  turn integer not null default 0 check (turn >= 0),
  next_handle integer not null default 1 check (next_handle >= 1),
  version integer not null default 0 check (version >= 0),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '12 hours',
  created_at timestamptz not null default now(),
  check (jsonb_typeof(surfaces) = 'array'),
  -- Snapshots stay small: detail is always loaded from the real resource.
  check (octet_length(surfaces::text) <= 400000)
);

create index live_workspaces_recent_idx on public.live_workspaces (workspace_id, user_id, updated_at desc);

-- The conversation must be the author's own, in the same workspace.
create or replace function public.check_live_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.workspace_id = new.workspace_id and c.user_id = new.user_id
  ) then
    raise exception 'conversation must belong to the same workspace and user';
  end if;
  return new;
end;
$$;

create trigger live_workspaces_check before insert or update on public.live_workspaces
  for each row execute function public.check_live_workspace();

-- Deleting (archiving) a conversation removes its workspace too.
create or replace function public.forget_archived_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    delete from public.live_workspaces where conversation_id = new.id;
  end if;
  return new;
end;
$$;

create trigger conversations_forget_workspace after update of archived_at on public.conversations
  for each row execute function public.forget_archived_workspace();

alter table public.live_workspaces enable row level security;

create policy "Authors read their live workspaces" on public.live_workspaces
  for select to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Authors create their live workspaces" on public.live_workspaces
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Authors update their live workspaces" on public.live_workspaces
  for update to authenticated
  using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "Authors delete their live workspaces" on public.live_workspaces
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Changes from another tab, the Approval Center or background work arrive without a refresh.
alter publication supabase_realtime add table public.live_workspaces;
