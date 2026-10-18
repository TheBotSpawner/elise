-- ELISE Home (ADR-079): homes, their local hubs, rooms, devices, groups, modes and the physical
-- commands sent to a hub. Home Assistant (or a future provider) owns the real devices and their
-- state; ELISE keeps names, aliases, rooms, favorites, modes, a state cache with freshness and a
-- short command audit — never a long-term occupancy history. Every row belongs to a workspace.

insert into public.capability_definitions (key, display_name, status) values
  ('home', 'Home', 'available')
on conflict (key) do update set status = 'available';

create table public.homes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  timezone text,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index homes_workspace_idx on public.homes (workspace_id);

-- A hub is the local bridge (the ELISE Home Hub agent on a PC today). Its credential is a
-- hub-only token: stored as a hash, revocable, never a user's session.
create table public.home_hubs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  name text not null default 'ELISE Home Hub' check (char_length(btrim(name)) between 1 and 80),
  provider text not null default 'home_assistant' check (provider in ('home_assistant')),
  -- Where the hub runs: ELISE Desktop on a PC today; a background service or ELISE hardware later.
  host_kind text not null default 'desktop' check (host_kind in ('desktop', 'service', 'hardware')),
  -- The local home runtime (managed by the host): starting, ready or failing.
  runtime_state text not null default 'initializing' check (runtime_state in ('initializing', 'ready', 'error')),
  token_prefix text not null,
  last_seen_at timestamptz,
  provider_connected boolean not null default false,
  agent_version text check (agent_version is null or char_length(agent_version) <= 40),
  protocol_version integer,
  provider_version text check (provider_version is null or char_length(provider_version) <= 40),
  last_sync_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index home_hubs_home_idx on public.home_hubs (home_id) where revoked_at is null;

-- The hub's credential (a hash), apart: server-only (RLS on, no policies).
create table public.home_hub_credentials (
  hub_id uuid primary key references public.home_hubs (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);

-- Single-use, short-lived pairing codes (only their hash is kept). Server-only.
create table public.home_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.home_rooms (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  -- The provider's area, when it came from one (rooms can also be ELISE-only).
  provider_area_id text,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  display_name text check (display_name is null or char_length(btrim(display_name)) between 1 and 80),
  icon text check (icon is null or char_length(icon) <= 16),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 12),
  favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (home_id, provider_area_id)
);

create table public.home_devices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  hub_id uuid not null references public.home_hubs (id) on delete cascade,
  -- Opaque provider identity (device id, or entity id for devices without one).
  provider_key text not null check (char_length(provider_key) between 1 and 300),
  provider_device_id text,
  provider_entity_ids text[] not null default '{}' check (cardinality(provider_entity_ids) <= 30),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  display_name text check (display_name is null or char_length(btrim(display_name)) between 1 and 80),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 12),
  room_id uuid references public.home_rooms (id) on delete set null,
  -- The user moved it: the provider's area no longer decides its room.
  room_override boolean not null default false,
  device_type text not null check (device_type in ('light', 'switch', 'climate', 'fan', 'humidifier', 'media_player', 'sensor')),
  capabilities jsonb not null default '[]'::jsonb check (octet_length(capabilities::text) <= 8000),
  state jsonb not null default '{}'::jsonb check (octet_length(state::text) <= 4000),
  available boolean not null default true,
  state_updated_at timestamptz,
  favorite boolean not null default false,
  hidden boolean not null default false,
  -- No longer reported by the provider: kept (aliases, modes) until it comes back.
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hub_id, provider_key)
);
create index home_devices_home_idx on public.home_devices (home_id) where removed_at is null;

create table public.home_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 12),
  device_ids uuid[] not null default '{}' check (cardinality(device_ids) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Modes ("Modo Estudio"): typed actions per device, validated by ELISE — never a prompt.
create table public.home_scenes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  icon text check (icon is null or char_length(icon) <= 16),
  aliases text[] not null default '{}' check (cardinality(aliases) <= 12),
  actions jsonb not null default '[]'::jsonb check (octet_length(actions::text) <= 16000),
  favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Physical commands: validated canonical actions for one device, with a short TTL. The hub
-- claims queued ones atomically (queued → delivered), so a retry never runs one twice.
create table public.home_commands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  home_id uuid not null references public.homes (id) on delete cascade,
  hub_id uuid not null references public.home_hubs (id) on delete cascade,
  device_id uuid not null references public.home_devices (id) on delete cascade,
  actions jsonb not null check (jsonb_typeof(actions) = 'array' and octet_length(actions::text) <= 4000),
  status text not null default 'queued'
    check (status in ('queued', 'delivered', 'executing', 'succeeded', 'failed', 'expired', 'cancelled')),
  origin text not null default 'user_ui' check (origin in ('user_ui', 'ai', 'schedule', 'system')),
  risk text not null default 'low' check (risk in ('low', 'medium', 'high')),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) <= 200),
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  delivered_at timestamptz,
  finished_at timestamptz,
  error_code text check (error_code is null or char_length(error_code) <= 60),
  result jsonb check (result is null or octet_length(result::text) <= 4000)
);
create unique index home_commands_idempotency on public.home_commands (workspace_id, idempotency_key)
  where idempotency_key is not null;
create index home_commands_pending_idx on public.home_commands (hub_id, created_at)
  where status = 'queued';

create trigger homes_updated_at before update on public.homes
  for each row execute function public.set_updated_at();
create trigger home_hubs_updated_at before update on public.home_hubs
  for each row execute function public.set_updated_at();
create trigger home_rooms_updated_at before update on public.home_rooms
  for each row execute function public.set_updated_at();
create trigger home_devices_updated_at before update on public.home_devices
  for each row execute function public.set_updated_at();
create trigger home_groups_updated_at before update on public.home_groups
  for each row execute function public.set_updated_at();
create trigger home_scenes_updated_at before update on public.home_scenes
  for each row execute function public.set_updated_at();

alter table public.homes enable row level security;
alter table public.home_hubs enable row level security;
alter table public.home_pairing_codes enable row level security;
alter table public.home_hub_credentials enable row level security;
alter table public.home_rooms enable row level security;
alter table public.home_devices enable row level security;
alter table public.home_groups enable row level security;
alter table public.home_scenes enable row level security;
alter table public.home_commands enable row level security;

-- Members manage their workspace's home. Hubs are created and updated by the server when a
-- pairing code is redeemed (service role); members can see and rename or revoke them.
create policy "Members read homes" on public.homes for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Members add homes" on public.homes for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy "Members change homes" on public.homes for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read hubs" on public.home_hubs for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Members change hubs" on public.home_hubs for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
-- Pairing codes and hub credentials: no policies — only the server reads or writes them.

create policy "Members read rooms" on public.home_rooms for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Members add rooms" on public.home_rooms for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy "Members change rooms" on public.home_rooms for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "Members delete rooms" on public.home_rooms for delete to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "Members read devices" on public.home_devices for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Members change devices" on public.home_devices for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy "Members read groups" on public.home_groups for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Members add groups" on public.home_groups for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy "Members change groups" on public.home_groups for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "Members delete groups" on public.home_groups for delete to authenticated
  using (public.is_workspace_member(workspace_id));

create policy "Members read scenes" on public.home_scenes for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Members add scenes" on public.home_scenes for insert to authenticated
  with check (public.is_workspace_member(workspace_id));
create policy "Members change scenes" on public.home_scenes for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy "Members delete scenes" on public.home_scenes for delete to authenticated
  using (public.is_workspace_member(workspace_id));

-- Commands: members create them (through ELISE's policy) and read their results; only the
-- server, on behalf of the authenticated hub, moves them through their lifecycle.
create policy "Members read commands" on public.home_commands for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy "Members add commands" on public.home_commands for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and status = 'queued');

-- Screens follow devices, hubs and command results live.
alter publication supabase_realtime add table public.home_devices;
alter publication supabase_realtime add table public.home_hubs;
alter publication supabase_realtime add table public.home_commands;
