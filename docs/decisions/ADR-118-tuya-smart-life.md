# ADR-118: Smart Life / Tuya remotes through Tuya's official cloud API

**Status:** Accepted (2026-10-23). Extends ADR-079 (ELISE Home), ADR-110 (infrared) and ADR-117.
Off by default (`TUYA_ENABLED=false`).

## Context

People set up their TV and air conditioner once in Smart Life (Tuya) with a Tuya infrared hub.
With a Broadlink, ELISE can't read the BroadLink app's remotes (ADR-117). Tuya is different: its
cloud OpenAPI documents the virtual remotes on a hub, their keys and how to send them
(Universal Infrared v2.0).

Only official, documented endpoints are used. There is no app scraping, no private API, no
person's password, no intermediary service and no other account's keys.

## Decision

1. **Provider.** `src/infrastructure/home/tuya.ts` holds ELISE's own Tuya cloud project
   (Smart Home): `TUYA_CLIENT_ID`, `TUYA_CLIENT_SECRET`, `TUYA_REGION` (data center). These are
   server-only and never reach Desktop's renderer or the browser.
   - **Signing:** HMAC-SHA256 as in Tuya's "Sign Request", without signed headers.
   - **Token:** the project token (`/v1.0/token?grant_type=1`) is cached until a minute before
     expiry and refreshed with `/v1.0/token/{refresh_token}`. If the refresh is refused, a new
     token is requested. Token codes 1010/1011 drop the token and retry once.
   - **Pausing:** a refused signature, credentials or clock (1004/1005/1013/2009) pauses Tuya for
     10 minutes. A rate limit (HTTP 429, code 40000309) pauses it for 60 s. A permission refusal
     (1106, 28841105) names the missing authorization without pausing.
   - **Caching:** device lists are cached 60 s; remotes and keys, 10 minutes.
2. **Endpoints.**
   - Read:
     - `GET /v1.0/users/{uid}/devices` (the account's devices; IR hubs have a `…ykq` category such
       as `wnykq`);
     - `GET /v2.0/infrareds/{id}/remotes`;
     - `GET …/remotes/{remote_id}/keys` (`key_list`, and for an AC `key_range`: modes → temperatures
       → fan speeds).
   - Send:
     - `POST …/remotes/{remote_id}/command` (`category_id`, `key`, `remote_index`);
     - `POST …/raw/command` (learned remotes, category 999, `key_id`);
     - `POST /v2.0/infrareds/{id}/air-conditioners/{remote_id}/scenes/command` (`power`, `mode`
       0–4, `temp`, `wind` 0–3).
3. **Model.** No new Home module. A remote is a `home_devices` row:
   - `provider_key = 'tuya:<infrared_id>:<remote_id>'`;
   - capability `tuya_ir` with Tuya's keys (each with ELISE's meaning: `power_toggle`, `mute`,
     `volume_up`, …) and, for an AC, its ranges.
   - It validates with the same rules as infrared (ADR-110):
     - a single Power is a toggle, never a promised "off";
     - volume moves only by steps.
   - An AC takes any mode, temperature or fan speed that Tuya listed, and nothing outside that.
   - Actions `tuya_key` and `tuya_ac` never go to the home's hub. They go straight to Tuya from the
     server, so they work with Desktop closed. State is ELISE's estimate (`estimated`), not a
     reading.
   - Voice uses the existing `home.*` tools, with no `tuya.*` tools.
4. **Whose account.**
   - **Development (now).** The person links their Smart Life account to the project with the
     console's QR ("Devices → Link App Account"). The server is configured with that account's
     UID (`TUYA_DEV_UID`) and the single workspace allowed to use it (`TUYA_DEV_WORKSPACE_ID`).
     Every other workspace sees the blocked state.
   - **Ownership check.** Every send checks Tuya's own device list that the remote's hub belongs
     to that account, and that it's online. Members can edit device rows, so a row is never proof.
   - **Writes.** Rows are written by the server only, scoped to the person's workspace and home.
   - **Consumer accounts (any person, OAuth).** This needs Tuya's authorization for third-party
     apps, which ELISE doesn't have. It's built as a blocked, explanatory state: no fake OAuth, no
     password field.
5. **Hogar.** "Buscar dispositivos" shows "Conectar Tuya / Smart Life" (web and Desktop) when
   enabled:
   - the hierarchy is hub → its remotes;
   - "Agregar" or "Agregar N" imports them;
   - importing again refreshes keys and never duplicates;
   - a remote named like a device already in the home (for example the same TV through the
     engine) is flagged and not imported unless the person says "Agregar igual";
   - "Probar" sends one safe key (mute, else power; an AC's power on) only after an explicit
     confirmation;
   - there is no "Aprender botones" for these.
6. **Rows hang off the home's hub for now.** `home_devices.hub_id` is NOT NULL, so a Smart Life
   remote is stored under the home's current hub. The hub never reports it and its sync never
   removes it, like ADR-110's infrared devices. No migration.

## Status of each part

| Part | Status |
| --- | --- |
| Signing, token, refresh, errors, pausing, caching | Documented; tested with mocks |
| Remote/key mapping, AC ranges, validation, isolation, dedup, sync | Tested with mocks |
| Real Tuya project (token, devices, remotes, keys) | Pending: needs the project's credentials |
| Physical IR (the TV/AC reacting) | Pending |
| `command` body casing (the doc's table says `category_id`; its example, `categoryId`) | Pending real verification (`scripts/tuya-check.ts send`) |
| Consumer OAuth | Blocked (needs Tuya's authorization) |
| Homes with no ELISE hub | Pending: migration making `hub_id` nullable |

## Consequences

- With Smart Life set up once, the person's TV and AC appear ready in ELISE and answer voice.
  Nothing is learned again.
- Tuya's cloud is a dependency for these devices: no internet, no control. Tuya's API has usage
  quotas per project and plan; nothing is bought without the owner's decision.
- Hogar's controls follow the hub's online state today (a UI simplification). Voice and
  `executeHomeCommands` don't depend on it.
