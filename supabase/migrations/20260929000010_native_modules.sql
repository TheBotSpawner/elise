-- My Elise Native: Habits, Goals, Lists and Notes (docs/architecture/10, 16 §45-56).
-- Explicit domain tables (no generic entity-attribute-value). ELISE Native is the provider of
-- these capabilities: every workspace gets capability grants + default bindings for them.

update public.capability_definitions set status = 'available'
  where key in ('habits', 'goals', 'lists', 'notes');

-- ── Habits ───────────────────────────────────────────────────────────────────
create table public.habits (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (char_length(description) <= 2000),
  -- daily: target per day · weekly: target per week (sessions, or a quantity when unit is set)
  -- · specific_days: target on the chosen weekdays.
  frequency_type text not null check (frequency_type in ('daily', 'weekly', 'specific_days')),
  target_value numeric not null default 1 check (target_value > 0 and target_value <= 100000),
  unit text check (char_length(unit) <= 30),
  -- 0 = Sunday … 6 = Saturday; required for specific_days, optional preference otherwise.
  preferred_days smallint[] not null default '{}',
  active boolean not null default true,
  start_date date not null default current_date,
  metadata jsonb not null default '{}'::jsonb,
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint habits_specific_days check (frequency_type <> 'specific_days' or cardinality(preferred_days) > 0)
);

create index habits_workspace_idx on public.habits (workspace_id, active) where archived_at is null;

-- One entry per habit per local day: check-ins on the same day correct or add to it.
create table public.habit_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  habit_id uuid not null references public.habits (id) on delete cascade,
  entry_date date not null,
  value numeric not null default 1 check (value >= 0 and value <= 1000000),
  status text not null default 'done' check (status in ('done', 'skipped')),
  notes text check (char_length(notes) <= 1000),
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (habit_id, entry_date)
);

create index habit_entries_range_idx on public.habit_entries (workspace_id, habit_id, entry_date desc);

-- ── Goals ────────────────────────────────────────────────────────────────────
create table public.goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  description text check (char_length(description) <= 5000),
  status text not null default 'active' check (status in ('active', 'completed', 'paused', 'cancelled')),
  target_date date,
  -- binary: done/not done · numeric: current → target (e.g. 100 clients, 1:45 = 105 min)
  -- · percentage: 0–100 set by hand.
  progress_type text not null default 'binary' check (progress_type in ('binary', 'numeric', 'percentage')),
  -- manual: the user's value · linked: derived from linked tasks/habits · hybrid: both, averaged.
  progress_mode text not null default 'manual' check (progress_mode in ('manual', 'linked', 'hybrid')),
  start_value numeric,
  current_value numeric,
  target_value numeric,
  -- Lower is better (race times, weight): progress runs from start down to target.
  direction text not null default 'increase' check (direction in ('increase', 'decrease')),
  metric text check (char_length(metric) <= 60),
  parent_goal_id uuid references public.goals (id) on delete set null,
  completed_at timestamptz,
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint goals_parent_not_self check (parent_goal_id is null or parent_goal_id <> id)
);

create index goals_workspace_idx on public.goals (workspace_id, status) where archived_at is null;

create table public.goal_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  goal_id uuid not null references public.goals (id) on delete cascade,
  resource_type text not null check (resource_type in ('habit', 'task', 'goal', 'note', 'entity')),
  resource_id uuid not null,
  relationship_type text not null default 'supports' check (relationship_type in ('supports', 'milestone', 'related')),
  created_at timestamptz not null default now(),
  unique (goal_id, resource_type, resource_id)
);

create index goal_links_resource_idx on public.goal_links (workspace_id, resource_type, resource_id);

-- A link may only point at a record of the same workspace (no dangling or foreign links).
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
    else false -- entities arrive with the Entities milestone
  end;
  if not ok or not exists (select 1 from public.goals g where g.id = new.goal_id and g.workspace_id = new.workspace_id) then
    raise exception 'goal link must reference a record of the same workspace';
  end if;
  return new;
end;
$$;

-- ── Lists ────────────────────────────────────────────────────────────────────
create table public.lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (char_length(description) <= 1000),
  status text not null default 'active' check (status in ('active', 'archived')),
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index lists_workspace_idx on public.lists (workspace_id) where archived_at is null;

create table public.list_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  list_id uuid not null references public.lists (id) on delete cascade,
  content text not null check (char_length(btrim(content)) between 1 and 500),
  checked boolean not null default false,
  -- Sparse ordering: new items go last; reorder rewrites positions of the list.
  position double precision not null,
  notes text check (char_length(notes) <= 1000),
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index list_items_order_idx on public.list_items (list_id, position) where archived_at is null;

-- ── Notes ────────────────────────────────────────────────────────────────────
-- The note is the single editable source of truth; Knowledge keeps an indexed representation
-- (knowledge_items.external_id = note id) that is re-indexed when the note changes.
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  content text not null default '' check (char_length(content) <= 100000),
  space_id uuid references public.knowledge_spaces (id) on delete set null,
  status text not null default 'active' check (status in ('active', 'archived')),
  source text not null default 'user_ui' check (source in ('user_ui', 'ai', 'schedule', 'import', 'system')),
  created_by_user_id uuid references auth.users (id) on delete set null,
  fts tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index notes_workspace_idx on public.notes (workspace_id, updated_at desc) where archived_at is null;
create index notes_fts_idx on public.notes using gin (fts);

create trigger goal_links_check before insert or update on public.goal_links
  for each row execute function public.check_goal_link();

-- Same-workspace guards for parents and containers.
create or replace function public.check_native_parent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Nested IFs: PL/pgSQL only evaluates the branch of the table that fired the trigger.
  if tg_table_name = 'habit_entries' then
    if not exists (select 1 from public.habits h where h.id = new.habit_id and h.workspace_id = new.workspace_id) then
      raise exception 'habit must belong to the same workspace';
    end if;
  elsif tg_table_name = 'list_items' then
    if not exists (select 1 from public.lists l where l.id = new.list_id and l.workspace_id = new.workspace_id) then
      raise exception 'list must belong to the same workspace';
    end if;
  elsif tg_table_name = 'goals' then
    if new.parent_goal_id is not null and not exists (
      select 1 from public.goals g where g.id = new.parent_goal_id and g.workspace_id = new.workspace_id
    ) then
      raise exception 'parent goal must belong to the same workspace';
    end if;
  elsif tg_table_name = 'notes' then
    if new.space_id is not null and not exists (
      select 1 from public.knowledge_spaces s where s.id = new.space_id and s.workspace_id = new.workspace_id
    ) then
      raise exception 'space must belong to the same workspace';
    end if;
  end if;
  return new;
end;
$$;

create trigger habit_entries_parent before insert or update on public.habit_entries
  for each row execute function public.check_native_parent();
create trigger list_items_parent before insert or update on public.list_items
  for each row execute function public.check_native_parent();
create trigger goals_parent before insert or update on public.goals
  for each row execute function public.check_native_parent();
create trigger notes_space before insert or update on public.notes
  for each row execute function public.check_native_parent();

create trigger habits_updated_at before update on public.habits
  for each row execute function public.set_updated_at();
create trigger habit_entries_updated_at before update on public.habit_entries
  for each row execute function public.set_updated_at();
create trigger goals_updated_at before update on public.goals
  for each row execute function public.set_updated_at();
create trigger lists_updated_at before update on public.lists
  for each row execute function public.set_updated_at();
create trigger list_items_updated_at before update on public.list_items
  for each row execute function public.set_updated_at();
create trigger notes_updated_at before update on public.notes
  for each row execute function public.set_updated_at();

-- ── RLS: members of the workspace manage its native data; nothing is hard-deleted by users
-- except check-ins, links and list items, which are lightweight. ─────────────────────────
alter table public.habits enable row level security;
alter table public.habit_entries enable row level security;
alter table public.goals enable row level security;
alter table public.goal_links enable row level security;
alter table public.lists enable row level security;
alter table public.list_items enable row level security;
alter table public.notes enable row level security;

create policy "Members read habits" on public.habits for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add habits" on public.habits for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change habits" on public.habits for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members manage habit entries" on public.habit_entries for all to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read goals" on public.goals for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add goals" on public.goals for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change goals" on public.goals for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members manage goal links" on public.goal_links for all to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read lists" on public.lists for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add lists" on public.lists for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change lists" on public.lists for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members manage list items" on public.list_items for all to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read notes" on public.notes for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members add notes" on public.notes for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy "Members change notes" on public.notes for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

revoke delete on public.habits, public.goals, public.lists, public.notes from anon, authenticated;
revoke all on public.habits, public.habit_entries, public.goals, public.goal_links,
  public.lists, public.list_items, public.notes from anon;

alter publication supabase_realtime add table
  public.habits, public.habit_entries, public.goals, public.goal_links,
  public.lists, public.list_items, public.notes;

-- ── ELISE Native provides these capabilities in every workspace ─────────────
create or replace function public.provision_native_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  native_connection_id uuid;
  capability text;
begin
  insert into public.provider_connections
    (workspace_id, provider_key, created_by_user_id, external_account_id, display_name, status)
  values (new.id, 'elise_native', new.owner_user_id, new.id::text, 'ELISE', 'connected')
  returning id into native_connection_id;

  foreach capability in array array['tasks', 'habits', 'goals', 'lists', 'notes'] loop
    insert into public.connection_capabilities (workspace_id, connection_id, capability_key, permission_level)
    values (new.id, native_connection_id, capability, 'write');
    insert into public.capability_bindings (workspace_id, capability_key, connection_id, is_default)
    values (new.id, capability, native_connection_id, true);
  end loop;

  return new;
end;
$$;

-- Existing workspaces get the new native capabilities too.
insert into public.connection_capabilities (workspace_id, connection_id, capability_key, permission_level)
select c.workspace_id, c.id, cap, 'write'
from public.provider_connections c
cross join unnest(array['habits', 'goals', 'lists', 'notes']) as cap
where c.provider_key = 'elise_native'
on conflict (connection_id, capability_key) do nothing;

insert into public.capability_bindings (workspace_id, capability_key, connection_id, is_default)
select c.workspace_id, cap, c.id, true
from public.provider_connections c
cross join unnest(array['habits', 'goals', 'lists', 'notes']) as cap
where c.provider_key = 'elise_native'
  and not exists (
    select 1 from public.capability_bindings b
    where b.workspace_id = c.workspace_id and b.capability_key = cap and b.connection_id = c.id
  );
