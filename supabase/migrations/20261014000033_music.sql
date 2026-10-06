-- Music (ADR-042): a canonical capability implemented by provider adapters. Spotify is a
-- connected account (OAuth, encrypted credentials); YouTube is server-provided search plus the
-- official embedded player, enabled per workspace; Deezer is planned (its API is closed to new
-- apps). Playback controls are low-risk writes (policy in code).

insert into public.capability_definitions (key, display_name, status) values
  ('music', 'Music', 'available')
on conflict (key) do update set status = 'available';

insert into public.provider_definitions (key, display_name, auth_type, supports_multiple_accounts, status) values
  ('spotify', 'Spotify', 'oauth2', false, 'available'),
  ('youtube', 'YouTube', 'api_key', false, 'available'),
  ('deezer', 'Deezer', 'oauth2', false, 'planned')
on conflict (key) do nothing;

insert into public.provider_capabilities (provider_key, capability_key) values
  ('spotify', 'music'),
  ('youtube', 'music'),
  ('deezer', 'music')
on conflict do nothing;
