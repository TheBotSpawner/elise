# ADR-079: ELISE Home — native smart home through a local hub

**Status:** Accepted (2026-10-18). Migration `20261031000049_elise_home.sql`. See ADR-080 for
ELISE Desktop as the hub's host on a PC.

## Decision

- **ELISE Home is a capability, not a provider.** The model sees `home.*` tools only:
  - `home.status`;
  - `home.control` (a device, room, group or the whole home);
  - `home.runScene`;
  - `home.saveScene`;
  - `home.deleteScene`.

  There are no `homeAssistant.*`, vendor tools or arbitrary service calls. Provider ids, service
  names and payloads never reach the model, the UI or ELISE's tables. They travel only as opaque
  provider keys that the hub understands.
- **Home Assistant is the first provider and the hardware abstraction.** It owns:
  - vendor integrations and pairing;
  - the real state and availability;
  - the device, entity and area registries.

  ELISE owns names, aliases, rooms, groups, favorites, modes, policy and a state cache with
  freshness.
- **Only documented Home Assistant APIs**, verified on 2026-10-18 against the WebSocket API
  page:
  - WebSocket `auth`, `get_states`, `config/entity_registry/list` (device, area and category of
    each entity), `subscribe_events` (`state_changed`) and `call_service`;
  - REST `POST /api/template` with `areas()`, `area_name`, `area_id` and `device_attr` for
    device and area names. The page doesn't document area or device registry listing, so ELISE
    doesn't use it.
  - No frontend scraping.
- **Normalization** (`infrastructure/home/home-assistant.ts`, pure code shared with the hub):
  - one ELISE device per physical device, built from its main controllable entity;
  - sensor-only devices keep their useful readings;
  - diagnostics, config entities, updates, hidden and disabled entities are dropped.

  Capabilities are ELISE's: `power`, `brightness`, `color`, `color_temp`, `temperature` (the
  device's range and step), `hvac_mode`, `fan_mode`, `fan_speed`, `humidity`, `volume`, `media`
  and `source`. Nothing assumes a transport, so IR (Broadlink) or Matter devices exposed by the
  provider use the same contract.
- **AI for intent, code for execution** (`core/home`):
  - the model passes words and values, absolute or relative;
  - `resolveDevice` finds real devices by name, alias, room and kind, and asks when two match;
  - `validateAction` checks each action against the device: an absolute value out of range
    fails, a relative one is clamped, and a mode changes only when asked.
- **Broad commands** ("apagá todo", a room, a group) only touch lights, plugs, fans, media and
  humidifiers, plus climate when it's named. Locks, alarms, garage doors and cameras aren't
  modeled, so they can't be controlled.
- **Risk:** reads are free and explicit low-risk commands run at once (`WRITE`). Deleting a mode
  always asks for approval. Sensitive classes will need their own policy when they're added.
- **The hub talks outbound only** (HTTPS long-poll with its own token; nothing at home is
  exposed). Commands are stored in `home_commands`:
  - each command is one device's validated actions;
  - lifecycle: `queued` → `delivered` → `executing` → `succeeded` / `failed` / `expired`;
  - TTL of 30 s: a stale command expires instead of running when the hub returns;
  - the hub claims queued commands with one atomic `UPDATE`, so a reconnect never runs one twice;
  - the hub also re-validates each command (schema, TTL, a device it reported, at most once);
  - commands for the same device run in order; different devices run in parallel.

  Supabase Realtime isn't used for the hub: it would need a user session or minted JWTs. The UI
  uses Realtime to follow devices, hub and results.
- **Hub credentials** are hub-only tokens (`ehh_…`), stored as a hash in a server-only table.
  They're revocable and replaced on re-registration, never a user session. Pairing codes:
  - single-use, valid 10 minutes, stored as a hash;
  - redeemed atomically, so a second attempt fails;
  - rate-limited.
- **Presence:**
  - a heartbeat every ~20 s, without noisy writes;
  - a hub silent for 75 s is offline, and offline means nothing is sent;
  - cached states are labeled as last known, never as current;
  - devices missing from a sync are marked `removed`, so their aliases and modes stay until
    they return.
- **Modes** are typed actions per device, validated when saved and again when run. Running one
  reports partial failures by name ("Modo Estudio activado. El humidificador no respondió.").
- **Privacy:** ELISE keeps the registry, a current-state cache, a short command audit, modes and
  aliases, but no long-term occupancy history and no camera imagery.
- **Data model:** the tables are `homes`, `home_hubs` (with `home_hub_credentials`),
  `home_pairing_codes`, `home_rooms`, `home_devices`, `home_groups`, `home_scenes` and
  `home_commands`.
  - All of them have workspace RLS.
  - Members can't mark commands done, and can't read credentials or codes.
  - Several homes per workspace and `home_id` separate from `hub_id` are ready for later.
- **Mi ELISE › Hogar:** hiding the module only hides it. It never unpairs, and never deletes
  devices, modes or aliases.

## Not in this version

- **Scheduling home actions in Programados** ("a las 23 activá Modo Dormir"). The scheduler's
  input is built around the Morning Brief (`actionType: morning_brief`), and adding a second
  action type is its own change. Until then ELISE says it isn't supported.
- **Groups** have their own table and are understood in conversation, but there's no editor yet.
- Conditional automations, Matter, Zigbee, Thread, IR and dedicated hardware: the abstractions
  allow them, and none is built.
