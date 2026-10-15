-- Slack (ADR-062): the first provider of the canonical Team Messaging capability. Slack stays the
-- source of truth: ELISE searches it live and stores no message history. A Slack connection is
-- one authorized user in one workspace (provider_connections, keyed by team + user); its OAuth
-- tokens use the existing encrypted vault (connection_secrets). Additive only.

insert into public.capability_definitions (key, display_name, status) values
  ('team_messaging', 'Team Messaging', 'available')
on conflict (key) do update set status = 'available';

insert into public.provider_definitions (key, display_name, auth_type, supports_multiple_accounts, status) values
  ('slack', 'Slack', 'oauth2', true, 'available')
on conflict (key) do nothing;

insert into public.provider_capabilities (provider_key, capability_key) values
  ('slack', 'team_messaging')
on conflict do nothing;

-- Rotating OAuth tokens (Slack's refresh tokens are single-use): one refresher at a time per
-- connection, across server instances and the background worker. A short lease, never a lock
-- that can be left held. connection_secrets keeps RLS on with no policies and no API-role
-- privileges, so this column is as unreachable from the browser as the ciphertext.
alter table public.connection_secrets
  add column if not exists refresh_lease_until timestamptz;
