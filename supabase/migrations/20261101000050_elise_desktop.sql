-- ELISE Desktop (ADR-081): the installations of a person's Desktop app and the one-time codes
-- that sign one in through the system browser. An installation id is random (never a hardware
-- fingerprint) and is not a credential. One person may have several computers.

create table public.desktop_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  installation_id uuid not null,
  name text not null default 'ELISE Desktop' check (char_length(btrim(name)) between 1 and 80),
  platform text not null check (platform in ('windows', 'macos', 'linux')),
  desktop_version text check (desktop_version is null or char_length(desktop_version) <= 40),
  bridge_protocol_version integer,
  capabilities text[] not null default '{}',
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, installation_id)
);
create index desktop_installations_workspace_idx on public.desktop_installations (workspace_id);

alter table public.desktop_installations enable row level security;

-- Each person sees and maintains only their own installations, in a workspace they belong to.
create policy "desktop_installations_select_own" on public.desktop_installations
  for select to authenticated using (user_id = (select auth.uid()));
create policy "desktop_installations_insert_own" on public.desktop_installations
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
create policy "desktop_installations_update_own" on public.desktop_installations
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));
grant select, insert, update on public.desktop_installations to authenticated;

-- Single-use sign-in codes (PKCE: only the challenge and the code's hash are kept). Server-only.
create table public.desktop_auth_codes (
  code_hash text primary key,
  challenge text not null check (char_length(challenge) between 43 and 128),
  user_id uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  installation_id uuid not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.desktop_auth_codes enable row level security;
revoke all on public.desktop_auth_codes from anon, authenticated;

-- Which computer hosts which home hub (ADR-080): commands go to that hub only.
alter table public.home_hubs add column installation_id uuid;
