-- Capability / provider registry, connections (concrete accounts) and capability bindings.
-- Catalog rows mirror src/core/capabilities/registry.ts and src/core/providers/registry.ts
-- (keys are asserted equal by tests/integration/database.test.ts).

create table public.capability_definitions (
  key text primary key,
  display_name text not null,
  status text not null default 'planned' check (status in ('available', 'planned', 'deprecated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.provider_definitions (
  key text primary key,
  display_name text not null,
  auth_type text not null check (auth_type in ('none', 'oauth2', 'api_key')),
  supports_multiple_accounts boolean not null default false,
  status text not null default 'planned' check (status in ('available', 'planned', 'deprecated')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.provider_capabilities (
  provider_key text not null references public.provider_definitions (key),
  capability_key text not null references public.capability_definitions (key),
  created_at timestamptz not null default now(),
  primary key (provider_key, capability_key)
);

insert into public.capability_definitions (key, display_name, status) values
  ('tasks', 'Tasks', 'available'),
  ('email', 'Email', 'planned'),
  ('calendar', 'Calendar', 'planned'),
  ('knowledge', 'Knowledge', 'planned'),
  ('habits', 'Habits', 'planned'),
  ('lists', 'Lists', 'planned'),
  ('goals', 'Goals', 'planned'),
  ('notes', 'Notes', 'planned'),
  ('finance', 'Finance', 'planned'),
  ('web_search', 'Web Search', 'planned'),
  ('voice', 'Voice', 'planned');

insert into public.provider_definitions (key, display_name, auth_type, supports_multiple_accounts, status) values
  ('elise_native', 'ELISE', 'none', false, 'available'),
  ('google', 'Google', 'oauth2', true, 'planned'),
  ('notion', 'Notion', 'oauth2', true, 'planned'),
  ('web_search', 'Web Search', 'api_key', false, 'planned');

insert into public.provider_capabilities (provider_key, capability_key) values
  ('elise_native', 'tasks'),
  ('elise_native', 'habits'),
  ('elise_native', 'lists'),
  ('elise_native', 'goals'),
  ('elise_native', 'notes'),
  ('elise_native', 'finance'),
  ('elise_native', 'knowledge'),
  ('google', 'email'),
  ('google', 'calendar'),
  ('google', 'tasks'),
  ('google', 'knowledge'),
  ('google', 'finance'),
  ('notion', 'knowledge'),
  ('web_search', 'web_search');

-- A concrete account authorized by the user (or the built-in ELISE Native "account").
-- Credentials never live here; they will live in a server-only secrets table.
create table public.provider_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider_key text not null references public.provider_definitions (key),
  created_by_user_id uuid references auth.users (id) on delete set null,
  external_account_id text not null,
  display_name text not null check (char_length(display_name) between 1 and 120),
  account_label text,
  context_label text,
  status text not null default 'connected' check (
    status in ('connecting', 'connected', 'needs_reauthorization', 'error', 'disabled', 'disconnected')
  ),
  auth_metadata jsonb not null default '{}'::jsonb,
  last_health_check_at timestamptz,
  last_connected_at timestamptz default now(),
  last_error_code text,
  last_error_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disconnected_at timestamptz,
  unique (workspace_id, provider_key, external_account_id)
);

create index provider_connections_workspace_idx on public.provider_connections (workspace_id);

create table public.connection_capabilities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  connection_id uuid not null references public.provider_connections (id) on delete cascade,
  capability_key text not null references public.capability_definitions (key),
  enabled boolean not null default true,
  permission_level text not null default 'write' check (permission_level in ('understand', 'read', 'write')),
  authorized_scopes text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, capability_key)
);

create table public.capability_bindings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  capability_key text not null references public.capability_definitions (key),
  connection_id uuid not null references public.provider_connections (id) on delete cascade,
  context_type text check (context_type in ('personal', 'work', 'entity', 'knowledge_space', 'custom')),
  context_id text,
  priority integer not null default 100,
  is_default boolean not null default false,
  enabled boolean not null default true,
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (connection_id, capability_key, context_type, context_id)
);

create index capability_bindings_lookup_idx
  on public.capability_bindings (workspace_id, capability_key) where enabled;

-- At most one default binding per capability and context in a workspace.
create unique index capability_bindings_single_default_idx
  on public.capability_bindings (workspace_id, capability_key, coalesce(context_type, ''), coalesce(context_id, ''))
  where is_default;

create trigger capability_definitions_updated_at before update on public.capability_definitions
  for each row execute function public.set_updated_at();
create trigger provider_definitions_updated_at before update on public.provider_definitions
  for each row execute function public.set_updated_at();
create trigger provider_connections_updated_at before update on public.provider_connections
  for each row execute function public.set_updated_at();
create trigger connection_capabilities_updated_at before update on public.connection_capabilities
  for each row execute function public.set_updated_at();
create trigger capability_bindings_updated_at before update on public.capability_bindings
  for each row execute function public.set_updated_at();

-- ELISE Native behaves as a provider: each workspace gets one built-in connection, and native
-- capabilities that are implemented get a default binding so they work before any configuration.
create or replace function public.provision_native_connection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  native_connection_id uuid;
begin
  insert into public.provider_connections
    (workspace_id, provider_key, created_by_user_id, external_account_id, display_name, status)
  values (new.id, 'elise_native', new.owner_user_id, new.id::text, 'ELISE', 'connected')
  returning id into native_connection_id;

  insert into public.connection_capabilities (workspace_id, connection_id, capability_key, permission_level)
  values (new.id, native_connection_id, 'tasks', 'write');

  insert into public.capability_bindings (workspace_id, capability_key, connection_id, is_default)
  values (new.id, 'tasks', native_connection_id, true);

  return new;
end;
$$;

create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute function public.provision_native_connection();

alter table public.capability_definitions enable row level security;
alter table public.provider_definitions enable row level security;
alter table public.provider_capabilities enable row level security;
alter table public.provider_connections enable row level security;
alter table public.connection_capabilities enable row level security;
alter table public.capability_bindings enable row level security;

create policy "Catalog is readable" on public.capability_definitions for select to authenticated using (true);
create policy "Catalog is readable" on public.provider_definitions for select to authenticated using (true);
create policy "Catalog is readable" on public.provider_capabilities for select to authenticated using (true);

create policy "Members read connections" on public.provider_connections
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy "Members update connections" on public.provider_connections
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

create policy "Members manage connection capabilities" on public.connection_capabilities
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.provider_connections c
      where c.id = connection_id and c.workspace_id = connection_capabilities.workspace_id
    )
  );

create policy "Members manage bindings" on public.capability_bindings
  for all to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (
    public.is_workspace_member(workspace_id)
    and exists (
      select 1 from public.provider_connections c
      where c.id = connection_id and c.workspace_id = capability_bindings.workspace_id
    )
  );
