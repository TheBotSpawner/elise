-- Google as an external provider: OAuth state, encrypted credentials, Calendar capability.
-- Authentication into ELISE (Supabase Auth, possibly with Google) and provider connections are
-- separate: nothing here is created from a sign-in.

update public.provider_definitions set status = 'available' where key = 'google';
update public.capability_definitions set status = 'available' where key = 'calendar';

-- Pending OAuth authorizations. One row per started flow; consumed exactly once by the callback.
create table public.oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider_key text not null references public.provider_definitions (key),
  -- Capabilities the user asked to enable in this flow (progressive authorization).
  capabilities text[] not null,
  -- Set when reconnecting or extending an existing connection.
  connection_id uuid references public.provider_connections (id) on delete cascade,
  -- PKCE verifier, encrypted with the application key.
  code_verifier_ciphertext text not null,
  return_path text not null default '/connections' check (return_path like '/%' and return_path not like '//%'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create index oauth_states_expiry_idx on public.oauth_states (expires_at);

alter table public.oauth_states enable row level security;

create policy "Users start their own authorizations" on public.oauth_states
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users read their own authorizations" on public.oauth_states
  for select to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));
create policy "Users consume their own authorizations" on public.oauth_states
  for delete to authenticated
  using (user_id = auth.uid() and public.is_workspace_member(workspace_id));

-- OAuth credentials, encrypted at the application level (AES-256-GCM, ELISE_ENCRYPTION_KEY).
-- RLS is enabled with NO policies and API roles have no privileges: only the server-side
-- credential store (service role) can read or write these rows.
create table public.connection_secrets (
  connection_id uuid primary key references public.provider_connections (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider_key text not null references public.provider_definitions (key),
  ciphertext text not null,
  access_token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger connection_secrets_updated_at before update on public.connection_secrets
  for each row execute function public.set_updated_at();

alter table public.connection_secrets enable row level security;
revoke all on public.connection_secrets from anon, authenticated;

-- Connections can be renamed/re-contexted by members; disconnecting is done server-side.
-- Bindings of a connection that is not connected are ignored by the resolver.
