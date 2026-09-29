-- Core tenancy: user profiles, workspaces, membership and preferences.
-- Every workspace-owned table in later migrations relies on public.is_workspace_member().

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  preferred_language text not null default 'es' check (preferred_language in ('es', 'en')),
  timezone text not null default 'UTC',
  avatar_url text,
  onboarding_status text not null default 'pending'
    check (onboarding_status in ('pending', 'completed', 'skipped')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  type text not null default 'personal' check (type in ('personal', 'team', 'business')),
  owner_user_id uuid not null references auth.users (id),
  default_language text not null default 'es' check (default_language in ('es', 'en')),
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  status text not null default 'active' check (status in ('active', 'invited', 'removed')),
  joined_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create index workspace_members_user_idx on public.workspace_members (user_id) where status = 'active';

-- Simple per-user settings that do not justify their own table. Not a replacement for Rules.
create table public.user_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 120),
  value_json jsonb not null,
  source text not null default 'user' check (source in ('user', 'onboarding', 'system')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id, key)
);

create trigger user_profiles_updated_at before update on public.user_profiles
  for each row execute function public.set_updated_at();
create trigger workspaces_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();
create trigger workspace_members_updated_at before update on public.workspace_members
  for each row execute function public.set_updated_at();
create trigger user_preferences_updated_at before update on public.user_preferences
  for each row execute function public.set_updated_at();

-- Membership check used by RLS policies. SECURITY DEFINER avoids recursive RLS on workspace_members.
create or replace function public.is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = target_workspace_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

-- Tenancy bootstrap: every new auth user gets a profile and a personal workspace they own.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid;
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  language text := case when meta ->> 'preferred_language' in ('es', 'en')
                        then meta ->> 'preferred_language' else 'es' end;
  tz text := coalesce(nullif(meta ->> 'timezone', ''), 'UTC');
begin
  -- Reject unknown timezone identifiers instead of storing garbage.
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = tz) then
    tz := 'UTC';
  end if;

  insert into public.user_profiles (id, display_name, preferred_language, timezone)
  values (
    new.id,
    coalesce(nullif(meta ->> 'full_name', ''), nullif(meta ->> 'name', ''), split_part(new.email, '@', 1)),
    language,
    tz
  );

  insert into public.workspaces (name, type, owner_user_id, default_language, timezone)
  values ('Personal', 'personal', new.id, language, tz)
  returning id into new_workspace_id;

  insert into public.workspace_members (workspace_id, user_id, role, status)
  values (new_workspace_id, new.id, 'owner', 'active');

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.user_profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.user_preferences enable row level security;

create policy "Users read their own profile" on public.user_profiles
  for select to authenticated using (id = auth.uid());
create policy "Users update their own profile" on public.user_profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "Members read their workspaces" on public.workspaces
  for select to authenticated using (public.is_workspace_member(id));
create policy "Owners update their workspaces" on public.workspaces
  for update to authenticated
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

create policy "Members read workspace membership" on public.workspace_members
  for select to authenticated using (public.is_workspace_member(workspace_id));

create policy "Users manage their own preferences" on public.user_preferences
  for all to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id))
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));
