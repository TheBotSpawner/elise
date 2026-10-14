-- ADR-055 Goals v2: Visions, Goal periods and icons, progress history, Goal ↔ Vision links,
-- circular-hierarchy and duplicate-link guards, and deleting Goals for good.
-- Existing Goals keep every value; nothing is converted into a Vision.

-- ── Visions: long-term, qualitative directions (no metric, no deadline) ─────────
create table public.visions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 500),
  description text check (char_length(description) <= 5000),
  -- One emoji, validated by ELISE on write and on read.
  icon text check (icon is null or char_length(icon) <= 16),
  area text check (area is null or char_length(btrim(area)) between 1 and 60),
  status text not null default 'active' check (status in ('active', 'achieved', 'archived')),
  achieved_at timestamptz,
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index visions_workspace_idx on public.visions (workspace_id, status);

create trigger visions_updated_at before update on public.visions
  for each row execute function public.set_updated_at();

alter table public.visions enable row level security;
create policy "Members read visions" on public.visions for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add visions" on public.visions for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change visions" on public.visions for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "Members delete visions" on public.visions for delete to authenticated using (public.is_workspace_member(workspace_id));
revoke all on public.visions from anon;

-- ── Goals: icon, area, a time horizon (period) and a currency for money goals ───
-- The deadline stays `target_date`; it follows the period's end unless the user overrides it.
alter table public.goals
  add column icon text check (icon is null or char_length(icon) <= 16),
  add column area text check (area is null or char_length(btrim(area)) between 1 and 60),
  add column period_start date,
  add column period_end date,
  add column currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  add constraint goals_period_order check (period_start is null or period_end is null or period_start <= period_end);

-- Goals may be deleted for good (links and history cascade); archive stays the default.
grant delete on public.goals to authenticated;
create policy "Members delete goals" on public.goals for delete to authenticated
  using (public.is_workspace_member(workspace_id));

-- A parent chain can never loop back ("A contributes to B contributes to A").
create or replace function public.check_goal_parent_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cursor_id uuid := new.parent_goal_id;
  depth int := 0;
begin
  while cursor_id is not null loop
    if cursor_id = new.id then
      raise exception 'goal hierarchy cannot be circular' using errcode = '23514';
    end if;
    depth := depth + 1;
    if depth > 50 then
      raise exception 'goal hierarchy is too deep' using errcode = '23514';
    end if;
    select g.parent_goal_id into cursor_id from public.goals g where g.id = cursor_id;
  end loop;
  return new;
end;
$$;

create trigger goals_no_cycle before insert or update of parent_goal_id on public.goals
  for each row when (new.parent_goal_id is not null) execute function public.check_goal_parent_cycle();

-- ── Goal links: Visions join habits, tasks, goals and notes ─────────────────────
-- relationship_type keeps its meaning: for habits and tasks, supports/milestone drive the
-- goal's linked progress and related is context only (ADR-055).
alter table public.goal_links drop constraint goal_links_resource_type_check;
alter table public.goal_links add constraint goal_links_resource_type_check
  check (resource_type in ('habit', 'task', 'goal', 'note', 'vision', 'entity'));

create or replace function public.check_goal_link()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ok boolean;
begin
  ok := case new.resource_type
    when 'habit' then exists (select 1 from public.habits r where r.id = new.resource_id and r.workspace_id = new.workspace_id)
    when 'task' then exists (select 1 from public.tasks r where r.id = new.resource_id and r.workspace_id = new.workspace_id)
    when 'goal' then exists (select 1 from public.goals r where r.id = new.resource_id and r.workspace_id = new.workspace_id and r.id <> new.goal_id)
    when 'note' then exists (select 1 from public.notes r where r.id = new.resource_id and r.workspace_id = new.workspace_id)
    when 'vision' then exists (select 1 from public.visions r where r.id = new.resource_id and r.workspace_id = new.workspace_id)
    else false -- entities arrive with the Entities milestone
  end;
  if not ok or not exists (select 1 from public.goals g where g.id = new.goal_id and g.workspace_id = new.workspace_id) then
    raise exception 'goal link must reference a record of the same workspace';
  end if;
  -- "A related to B" and "B related to A" are one relationship, stored once.
  if new.resource_type = 'goal' and exists (
    select 1 from public.goal_links x
    where x.goal_id = new.resource_id and x.resource_type = 'goal' and x.resource_id = new.goal_id
  ) then
    raise exception 'these goals are already related' using errcode = '23505';
  end if;
  return new;
end;
$$;

-- Deleting a record removes the links that point at it (goal_links.resource_id has no FK).
create or replace function public.cleanup_goal_links()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  delete from public.goal_links l
  where l.workspace_id = old.workspace_id and l.resource_type = tg_argv[0] and l.resource_id = old.id;
  return old;
end;
$$;

create trigger habits_cleanup_goal_links after delete on public.habits
  for each row execute function public.cleanup_goal_links('habit');
create trigger goals_cleanup_goal_links after delete on public.goals
  for each row execute function public.cleanup_goal_links('goal');
create trigger visions_cleanup_goal_links after delete on public.visions
  for each row execute function public.cleanup_goal_links('vision');

-- Links left behind by habits deleted before this migration (ADR-053 allowed deleting habits).
delete from public.goal_links l
where l.resource_type = 'habit'
  and not exists (select 1 from public.habits h where h.id = l.resource_id);

-- ── Progress history: append-only, auditable ────────────────────────────────────
create table public.goal_progress_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  goal_id uuid not null references public.goals (id) on delete cascade,
  previous_value numeric,
  new_value numeric,
  source_type text not null check (source_type in ('manual', 'habit', 'task', 'integration', 'system')),
  source_id uuid,
  note text check (char_length(note) <= 500),
  occurred_at timestamptz not null default now(),
  created_by_user_id uuid references auth.users (id) on delete set null
);

create index goal_progress_events_goal_idx on public.goal_progress_events (goal_id, occurred_at desc);

create or replace function public.check_goal_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.goals g where g.id = new.goal_id and g.workspace_id = new.workspace_id) then
    raise exception 'goal must belong to the same workspace';
  end if;
  return new;
end;
$$;

create trigger goal_progress_events_parent before insert on public.goal_progress_events
  for each row execute function public.check_goal_event();

alter table public.goal_progress_events enable row level security;
create policy "Members read goal progress" on public.goal_progress_events for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Members record goal progress" on public.goal_progress_events for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
-- History is never rewritten: no update or delete for users (it goes with its goal).
revoke update, delete on public.goal_progress_events from anon, authenticated;
revoke all on public.goal_progress_events from anon;

-- Existing goals start their history at the value they have today.
insert into public.goal_progress_events (workspace_id, goal_id, previous_value, new_value, source_type, occurred_at)
select workspace_id, id, null, current_value, 'system', updated_at
from public.goals
where current_value is not null;

alter publication supabase_realtime add table public.visions, public.goal_progress_events;
