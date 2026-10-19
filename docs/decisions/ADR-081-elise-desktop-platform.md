# ADR-081: ELISE Desktop v1 — one ELISE, a local renderer, Electron as a replaceable shell

**Status:** Accepted (2026-10-18). Builds on ADR-079 and ADR-080. Its open decision (the
managed Home runtime) is resolved by ADR-082.

## Context

ELISE is one product with several surfaces: Web today, Desktop now, Mobile later. Desktop has
to look and behave like ELISE, keep ELISE Home running at home, open even when the web frontend
(or the whole internet) is down, and stay open to future native capabilities. That rules out
three tempting shortcuts:

- a window that loads the production URL (it's blank when hosting is down);
- a second copy of the UI (two products drift);
- packaging the Next.js server (its server code holds secrets, and it can't be shipped to users).

## Decision

### One source, several builds

The web's own client components compile twice: Next.js for the web, Vite for Desktop's local
renderer (`desktop/`). Nothing is copied.

- **Server Actions** are replaced at build time with typed RPC calls to ELISE Cloud
  (`/api/desktop/rpc`). ELISE Cloud runs the same action by name, with its own auth and
  validation. The allowlist covers exactly the `"use server"` modules, minus sign-in and
  Desktop approval, and a test keeps it in sync.
- **Page data** comes from the web pages' own loaders (`home-props.ts`, `my-elise/home/props.ts`)
  through `/api/desktop/page`.
- **`next/link` and `next/navigation`** map to a local history router. No server is needed to
  move between screens.
- **The server boundary is enforced by the build:** importing `server-only`, `next/headers` or
  `next/cache` into the renderer fails it.

Ported in v1:

- the authenticated frame (the web's `AppShell`);
- Inicio (`ChatSurface`);
- Hogar (`HomeView`);
- Settings › ELISE Desktop.

Other sections say "todavía se abre en el navegador" and open the web. Porting each one is one
loader plus one route, not a rewrite.

### Platform layer, not `isElectron`

- **Core (`src/core/platform`)** defines the shared contract:
  - `PlatformInfo` (kind, capabilities, bridge protocol);
  - `featureSupport()`, which returns `supported`, `unsupported` or `update_required`;
  - the connectivity model (`internet`, `cloud`, `localRuntime` and `home`, each tracked
    separately);
  - deep-link parsing and the Desktop bridge interface.
- **Product code** asks `useFeature({ capability })` (`src/lib/platform`). The web reports no
  native capabilities.
- **Versioning is explicit and independent:**
  - bridge protocol;
  - local-runtime protocol;
  - Desktop version.

  The cloud's heartbeat answer says whether this Desktop is too old.

### Electron is the shell, not the product

Electron owns:

- the window, tray, single instance and start-at-login;
- the `elise://` deep links;
- updates;
- the local runtime's lifecycle.

ELISE's rules, tools, Home model and UI stay in `src/`. Replacing Electron means replacing
`desktop/src/main` and `preload`, nothing else.

- **Packaging: Electron Forge 8** (Vite plugin, Squirrel for Windows, DMG and ZIP for macOS,
  GitHub publisher, fuses). It is one coherent toolchain: no electron-builder alongside.
- **Security baseline:**
  - `contextIsolation`, `sandbox` and no `nodeIntegration`;
  - a frozen typed preload bridge, with no channel names exposed;
  - IPC accepted only from the app origin, with zod-validated arguments;
  - a custom `elise-app://` protocol instead of `file://`;
  - a strict CSP (no `unsafe-eval`);
  - navigation and new windows restricted; links open externally only after validation;
  - permissions denied by default;
  - fuses: no `RunAsNode`, no `--inspect`, asar integrity, cookie encryption.

### Sign-in and secrets

- **Sign-in goes through the system browser.**
  1. Desktop opens `/desktop/connect` with a PKCE challenge, a state value and its random
     installation id.
  2. The person, signed in with any method, approves.
  3. The browser returns to `elise://auth/callback`.
  4. Desktop exchanges the single-use code with its verifier. The code expires after 5 minutes,
     only its hash is stored, and it is bound to the installation.
  5. The result is a normal Supabase session (an admin magic-link token that is verified at once
     and never emailed).

  There are no Desktop accounts.
- **The main process holds the session** as the same cookies a browser keeps, encrypted with the
  OS through `safeStorage` (never plaintext). It attaches them to the renderer's `/api` calls,
  which the custom protocol proxies. The renderer only ever gets a short-lived access token,
  used for Realtime and uploads.

### Local runtime and degraded modes

- **ELISE Local Runtime** is its own process (Electron `utilityProcess`), supervised with bounded
  backoff. Its message protocol has no Electron types. Today it hosts one capability, `local.home`:
  the existing `HubAgent`, reused.
- **Closing the window keeps ELISE in the tray**, and ELISE Home keeps running. "Salir de ELISE"
  really quits, after stopping the runtime cleanly.
- **When the cloud is down:**
  - the app still opens from its own assets;
  - a compact banner explains the state;
  - allowlisted screens show last-known data labelled with its age, scoped per account and
    workspace;
  - cloud writes and AI are unavailable and say so;
  - Hogar's controls go to the local runtime, which runs the same canonical validation
    (`validateAction`) against Home Assistant. That requires someone signed in to the workspace
    the home belongs to.
- **Presence:** each installation is a row in `desktop_installations` (RLS, one per computer).
  Several computers per person are supported. The hub records which installation hosts it
  (`home_hubs.installation_id`).

## Consequences

- Shared UI changes reach Desktop through normal Desktop releases. There is no remote code
  loading: the renderer is packaged, which favors reliability and security over instant updates.
- Desktop and the web are released separately. The RPC and page endpoints are additive. Breaking
  them requires raising `MIN_DESKTOP_BRIDGE_PROTOCOL`.
- **Honest limits of v1:**
  - if the Electron main process dies, the runtime stops with it (it is not an OS service yet);
  - the update feed and code signing need real infrastructure and certificates;
  - only Inicio and Hogar are local screens.

## Open decision (not taken here)

**How ELISE installs and manages Home Assistant on the person's PC.** Today the runtime talks
to a Home Assistant already on the machine or network (`ELISE_HA_URL`, development). Home
Assistant's supported installation methods are HA OS (a VM or appliance) and HA Container
(Docker). Each brings a dependency people would have to accept: a hypervisor, or Docker. This
needs a product and licensing decision before it's built. The runtime manager's states and
contract (`HomeRuntimeState`) are already in place for whichever is chosen.
