# ADR-128: Smart Life test link for the owner; "found now" vs "found before" in Agregar dispositivos

**Status:** Accepted (2026-11-02). Amends ADR-119 §8 (the app may now read `TUYA_DEV_UID`, for
one workspace only) and ADR-090/103 (how Agregar dispositivos presents what the engine found).

## Context

- **Tuya, real check (2026-11-02, `scripts/tuya-check.ts`, project token, US data center).** The
  account linked in the console returns an infrared hub (`wnykq`, online) and two virtual remotes
  as sub-devices. `GET /v2.0/infrareds/{id}/remotes` and `…/keys` answer: a TV (category 2, 8
  keys) and an AC (category 5, PowerOn/PowerOff and mode → temperature → fan ranges). So the IR
  Control Hub service is authorized for the project and nothing has to be learned again.
- **Customer OAuth is still not usable.** No `TUYA_OAUTH_URL_*` is configured. Tuya's "OAuth 2.0
  Authorization Flow" says the authorization key "must be the one specific to app authorization"
  and never names Smart Life. ADR-119 §1 assumed Cloud Authorization keys; that assumption is now
  doubtful and stays unverified until the console flow is set up. The support note on official
  app data (K8sdy1gdbu7f0) couldn't be read (redirect loop).
- **Hogar couldn't use the linked account.** ADR-119 kept `TUYA_DEV_UID` for the script only, so
  the owner had no way to test the real hub from ELISE, and the row said "esperando la
  habilitación oficial" — vague, and not what is actually missing.
- **The dialog mixed two things.** "Dispositivos encontrados" were `home_devices` rows the engine
  registered at some point (`added_at` null), counted together with the engine's pending
  discoveries from this search. With no pending discoveries it said "Encontramos 6 · seguimos
  buscando" and "Todavía no encontramos dispositivos" at once. A background poll every 10 s kept
  "seguimos buscando" forever. Discoveries were merged by integration + name, so two devices
  with one name became one.

## Decision

1. **Test link (owner only).** `TUYA_DEV_UID`, `TUYA_REGION` and `TUYA_DEV_WORKSPACE_ID` (all
   server-only) name the account linked in the console, its data center, and the one workspace
   allowed to use it.
   - **Who sees it.** That workspace sees "Vincular cuenta de prueba", labeled "Solo desarrollo
     … No es la conexión para clientes". Nobody else sees it.
   - **Linking.** Linking reads the account's device list first: a Tuya refusal links nothing.
     Then it stores a `provider_connections` row with `auth_metadata.test = true` and no vault
     secret.
   - **Calls.** They use the project's token (`grant_type=1`) with the uid from ELISE's record.
     They go through the same ownership checks, import, sync, commands and disconnect as an
     OAuth connection.
   - **Ending.** Every token request re-checks the config. When it no longer names that workspace
     and uid, the link fails as `token` ("Volver a vincular").
2. **Customer state from real capability.**
   - **Not offered:** with no OAuth link and no test link, the row shows a disabled "Conectar" and
     "La conexión para clientes todavía no está habilitada". "Más información" names what's
     missing: OAuth 2.0 in the project (App Authorization key, callback, data center), and checking
     that it accepts Smart Life accounts.
   - **Offered:** with `TUYA_OAUTH_URL_*`, ADR-119's flow is unchanged.
3. **No Tuya uid reaches a browser.** The status action sends `TuyaConnectionView` (the
   connection without `uid`).
4. **Two blocks.**
   - **"En esta red":** the engine's pending discoveries from this search.
   - **"Servicios conectados":** Smart Life.
   - **"Encontrados anteriormente (N)":** the registered-but-not-added rows, folded by default,
     8 at a time. It claims no online/offline state: "ELISE los vio en otra búsqueda: no están
     confirmados ahora". The Hogar page uses the same folded section.
5. **One search, explicit states.**
   - **States:** `idle → scanning → completed | failed`. A failed or timed-out search (15 s) says
     so; there's no background poll.
   - **"Volver a buscar":** clears only the last search's results. Per-row progress, the history and
     the home's devices stay.
   - **Late answers:** each search has a generation number. An answer from an older search, or
     after the dialog closed, is dropped.
   - **Counts:** only current results are counted. "No encontramos dispositivos nuevos" appears
     only when this search found nothing. Five rows show, then "Ver los N".
6. **Identity of a discovery.** Integration + the engine's `unique_id` (serial, MAC, USN) when it
   has one, so one device seen by mDNS and SSDP is one row. Without one, each pending setup is
   its own row. A shared name never merges two devices. History rows are the engine's entities,
   one row each.
7. **Diagnostics.** Desktop's console gets `[home-discovery]` with duration, current/previous
   counts, the integrations seen, and `timeout`/`engine` errors. It never logs names, ids or
   addresses.
8. **Dialog.**
   - "Agregar dispositivos" with one context line, inside the existing `Dialog`: a native
     `<dialog>`, one scroll container, × and Escape.
   - "Agregar un Broadlink por IP" is a discreet footer disclosure.
   - "Omitir por ahora" stays for onboarding only.

## Status of each part

| Part | Status |
| --- | --- |
| Test link: scoping, Tuya-first validation, project token, revocation by config | Tested with mocks |
| Real hub + remotes + keys through the linked account | Tested against the real Tuya API (script); in Hogar pending the owner's click |
| Real IR command (TV Power) and its physical effect | Pending: the owner sends it and watches the TV |
| Customer OAuth (self-service) | Blocked: OAuth 2.0 not configured in the console; App Authorization key requirement unverified |
| Found now vs before, stale answers, failed search, dedup rule | Tested (UI + parser) |
| Dialog at small heights in Desktop | Pending visual check in a Desktop build |

## Consequences

- The owner can test the real Demasled hub end to end from Hogar without an OAuth that doesn't
  exist yet. Customers still see an honest "not enabled" state.
- What the dialog calls "found now" means only "the engine reported it in this search". Home
  Assistant can keep a pending discovery a while after a device leaves the network. That's the
  engine's view at search time, not a reachability probe.
