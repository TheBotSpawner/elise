-- ADR-110: infrared through a Broadlink (RM4 mini / RM4C mini) on the home engine.
--
-- Two kinds of rows, both in home_devices:
-- - the controller itself ("ir_controller"), synced by the hub like any other device;
-- - the things it controls (a TV, an air conditioner…), created by the person in ELISE:
--   provider_key 'ir:<uuid>', the commands they taught it in `capabilities` (an "ir" entry with
--   the controller's id). The hub never reports these, so a sync never removes them.
--
-- Additive: no existing row changes.

alter table public.home_devices drop constraint if exists home_devices_device_type_check;
alter table public.home_devices add constraint home_devices_device_type_check
  check (device_type in ('light', 'switch', 'climate', 'fan', 'humidifier', 'media_player', 'sensor', 'ir_controller'));

-- Learned commands and their presets need more room than a synced device's capabilities.
alter table public.home_devices drop constraint if exists home_devices_capabilities_check;
alter table public.home_devices add constraint home_devices_capabilities_check
  check (octet_length(capabilities::text) <= 16000);

-- A member creates an infrared device only on a controller of their own workspace's hub.
create policy "Members add infrared devices" on public.home_devices for insert to authenticated
  with check (
    public.is_workspace_member(workspace_id)
    and provider_key like 'ir:%'
    and added_at is not null
    and exists (
      select 1 from public.home_devices c
      where c.hub_id = home_devices.hub_id
        and c.workspace_id = home_devices.workspace_id
        and c.home_id = home_devices.home_id
        and c.device_type = 'ir_controller'
        and c.removed_at is null
    )
  );
