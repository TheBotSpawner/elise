-- ADR-119: Smart Life / Tuya as a per-user connected account (OAuth 2.0, the user's own data
-- center), and devices that live in Tuya's cloud with no ELISE Home hub.
--
-- Additive: no existing row changes. Every hub-reported and infrared device keeps its hub.

insert into public.provider_definitions (key, display_name, auth_type, supports_multiple_accounts, status) values
  ('tuya', 'Smart Life / Tuya', 'oauth2', true, 'available')
on conflict (key) do update set status = 'available', auth_type = 'oauth2';

insert into public.provider_capabilities (provider_key, capability_key) values
  ('tuya', 'home')
on conflict do nothing;

-- A cloud device (a Smart Life remote) belongs to the home, not to a hub: the hub is optional
-- for it, and only for it.
alter table public.home_devices alter column hub_id drop not null;
alter table public.home_devices drop constraint if exists home_devices_hub_or_cloud;
alter table public.home_devices add constraint home_devices_hub_or_cloud
  check (hub_id is not null or provider_key like 'tuya:%');

-- (hub_id, provider_key) stays unique for hub devices; cloud ones are unique per home.
create unique index if not exists home_devices_cloud_key
  on public.home_devices (home_id, provider_key) where hub_id is null;
