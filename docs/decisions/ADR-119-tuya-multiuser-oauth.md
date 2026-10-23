# ADR-119: Smart Life / Tuya for every user (official OAuth 2.0), cloud devices without a hub

**Status:** Accepted (2026-10-23). Supersedes ADR-118's account model (a single development
account bound by configuration). ADR-118's device model, mapping and execution rules still apply.

## Context

ELISE ships to many people. Any signed-in person must be able to:
- connect their own Smart Life or Tuya Smart account;
- import the remotes they already set up there;
- control them by voice and from Hogar;
- disconnect.

They must never need Tuya's developer console or an ELISE Home hub. ADR-118's
`TUYA_DEV_UID` + `TUYA_DEV_WORKSPACE_ID` only worked for the founder's account.

### What Tuya documents (checked 2026-10-23)

- **"OAuth 2.0 Authorization Flow"** (updated 05/01/2026):
  - **Where it's configured:** Cloud → project → Devices → Link App Account → **Configure OAuth 2.0
    Authorization**, which turns on login authorization and sets the **data center and callback URL**.
  - **The person's step:** they open the configured **H5 page** and log in or scan with the app.
  - **Callback:** the code arrives at the callback URL. "The callback URL should vary for different
    data centers"; "the authorization code can only be used in the user's data center."
  - **Not published:** the H5 link's exact format and the callback's parameter names. The console shows
    the link.
- **"Authentication Method":**
  - code mode is `GET /v1.0/token?grant_type=2&code=…`, signed with the client ID and secret, for
    access to user data;
  - "If you are using OAuth 2.0 authorization mode on **terminal**, `client_id` must be created
    from **App Authorization**";
  - signing follows "Sign Requests for App Authorization" or "… for Cloud Authorization" depending
    on where the client ID comes from.
- **"Manage Authorization / App Authorization":**
  - creates per-app keys for **iOS and Android** apps (bundle id / SHA1);
  - an added authorization can't be deleted.
- **"Device Data Sharing":**
  - EU Data Act only (Central Europe data center, enterprise verification, paid resource pack);
  - **not applicable** to Argentina.
- **Tokens:** `GET /v1.0/token/{refresh_token}` refreshes a token. The refresh token "only takes
  effect once"; the access token lives 2 h. No token revocation endpoint for this flow is
  documented.

## Decision

1. **Server-side OAuth with the cloud project's credentials.** ELISE Web and Desktop exchange
   the code on ELISE's server, not on a terminal. They use `TUYA_CLIENT_ID` / `TUYA_CLIENT_SECRET`
   (Cloud Authorization signing). App Authorization keys are for iOS/Android apps and aren't used.
   **To verify against Tuya with the first real authorization.** If Tuya requires an App
   Authorization key for this web flow, its client ID and secret become separate variables. They
   never replace the cloud ones silently.
2. **The flow:**
   - **Start.** "Conectar" (Hogar → Buscar dispositivos, or the setup screen) → a server action:
     - creates a single-use `oauth_states` row bound to user, workspace and data center, valid for
       10 minutes, with only its hash stored;
     - redirects to ELISE's own `/api/connections/tuya/go?s=…`.
   - **The `/go` hop.** It runs in the browser that will see Tuya's page: Desktop's system browser,
     or the web tab. It sets an HttpOnly cookie with the state and redirects to
     `TUYA_OAUTH_URL_<REGION>`, the console's H5 link, with `state` appended.
   - **Callback.** Tuya calls `/api/connections/tuya/callback/<region>`. ELISE:
     - requires the cookie; if Tuya returns `state`, it must match;
     - requires the path's data center to match the flow's;
     - if the browser has an ELISE session, requires it to be the same user;
     - consumes the flow before exchanging, so a retry never exchanges twice;
     - exchanges in that data center only.
   - **Results.** "Data centers inconsistency" becomes `wrong_region`, and the person picks the other
     data center.
   - ELISE never asks for or sees the Smart Life password.
3. **Storage:**
   - **The account.** One `provider_connections` row per Tuya account and data center
     (`provider_key 'tuya'`, `external_account_id '<region>:<uid>'`, `auth_metadata {region, uid}`),
     per workspace.
   - **Tokens.** They live in `connection_secrets` (AES-GCM bound to workspace and connection).
     Refresh holds the vault's lease: one refresher at a time, and the rotated refresh token is
     stored at once.
   - **A refused refresh** sets the connection to `needs_reauthorization` ("Reconectar").
   - **Problems** shown per connection: `token`, `wrong_region`, `permission` (IR service or
     permission not enabled), `quota`, `project`.
4. **Isolation:**
   - **Every operation** looks the connection up in the caller's workspace.
   - **The uid** comes from ELISE's record, never from the client.
   - **Every hub or remote, before reading or sending,** is checked against Tuya's own device list
     for that account's token.
   - **Device keys** are `tuya:<connectionId>:<infraredId>:<remoteId>`: two people's identical ids
     never collide, and names never merge.
   - **Desconectar** deletes that connection's secret and cache, and marks its devices removed
     (kept for history, never controllable again). Other accounts and workspaces are untouched.
5. **Cloud devices without a hub (migration 067, additive):**
   - `home_devices.hub_id` is nullable only for `provider_key like 'tuya:%'`;
   - such rows are unique per home;
   - `tuya` is registered as a provider of the `home` capability.
   - Hogar shows the dashboard when the home has cloud devices even with no hub, and their controls
     ignore the hub's online state.
   - The voice tools work with no hub.
   - **Before the migration is applied,** an import falls back to the home's hub when one exists;
     otherwise it says the database needs updating.
6. **Sync:** "Sincronizar", plus Hogar's load, at most every 6 h per connection (`after()`):
   - a renamed remote takes the new name, and the person's alias stays;
   - changed keys are refreshed;
   - a deleted remote leaves the home;
   - hub availability is updated.
   - Never adds anything by itself.
7. **Duplicates with the engine or a Broadlink:** a remote named like another device is flagged
   and not imported silently. The person chooses:
   - **"Usar Smart Life":** the other device is hidden and Smart Life's takes over;
   - **"Agregar los dos":** both stay.
8. **Feature flag:** `TUYA_ENABLED=false` by default.
   - With it on but no `TUYA_OAUTH_URL_*`, the entry shows the honest "todavía no disponible"
     state.
   - `TUYA_DEV_UID` / `TUYA_REGION` only serve `scripts/tuya-check.ts`. The app never reads them.

## Status of each part

| Part | Status |
| --- | --- |
| OAuth start / `/go` / callback, state, cookie, single use, data center, session | Tested with mocks |
| Code exchange, refresh with lease, `needs_reauthorization`, problem states | Tested with mocks |
| A/B isolation, IDOR, selective disconnect | Tested with mocks |
| Cloud-only import (no hub), dedup, preferred provider, sync | Tested with mocks |
| Project token, signing, `/v1.0/users/{uid}/devices` (real, linked dev account, 0 devices) | Tested against the real Tuya API |
| Tuya's H5 page, real callback parameters, `grant_type=2` with a real account | Pending: needs "Configure OAuth 2.0 Authorization" in the console |
| IR endpoints with a real hub (remotes, keys, command; body casing) | Pending: needs a Tuya IR hub |
| A second, independent account end to end | Pending |
| Migration 067 in production | Pending: owner's approval |

## Consequences

- Each person's devices answer to their own token and data center. No shared account.
- Tuya may tie OAuth for third parties, or the IR Control Hub service, to a commercial plan or
  approval. That shows up as `permission` / `quota` / "todavía no disponible", never as a fake
  success.
- Rows created under ADR-118 (no `connectionId`) are dropped from parsing. None exist in
  production.
