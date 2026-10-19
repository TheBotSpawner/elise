# 27 · ELISE Desktop: development, release and operations

Architecture and rationale: [ADR-081](../decisions/ADR-081-elise-desktop-platform.md). This
page covers how to work with Desktop day to day.

## Layout

| Path | What |
|---|---|
| `desktop/src/main` | Electron main process: window, tray, deep links, session, IPC, updates, runtime supervision |
| `desktop/src/preload` | The frozen `window.eliseDesktop` bridge (no channel names leak) |
| `desktop/src/runtime` | ELISE Local Runtime (`utilityProcess`), today hosting `local.home` (`home-hub/agent.ts`) |
| `desktop/src/renderer` | Local renderer: router, Next shims, RPC, the few Desktop-only screens |
| `desktop/vite.renderer.config.ts` | Compiles the shared `src/` for Desktop (action stubs, shims, server-only guard) |
| `src/core/platform` | Shared contract: capabilities, protocol versions, connectivity, deep links, bridge |
| `src/app/api/desktop/*` | Cloud endpoints: `session`, `heartbeat`, `rpc`, `page` |
| `src/app/desktop/connect` | The browser page where a person approves ELISE Desktop |

`desktop/` has its own `package.json`, so Electron and Forge never install for the web or
Vercel. It reuses the root `node_modules` for React, Vite and everything shared.

## Develop

```bash
npm install                 # root
npm install --prefix desktop
npm run dev                 # web on :3000 (ELISE Cloud for Desktop in development)
npm run dev:desktop         # Electron + renderer HMR (loads through elise-app://, like production)
```

- **ELISE Home in development:** set `ELISE_HA_URL` and `HA_TOKEN` (a long-lived token of a
  local Home Assistant) before `dev:desktop`. Without them, Home reports "No configurada".
- **Running inside VS Code's extension host:** if `ELECTRON_RUN_AS_NODE` is set in your shell,
  unset it first, or Electron runs as plain Node. Packaged builds ignore it (fuse).

## Checks

| Command | What |
|---|---|
| `npm run typecheck:desktop` | Desktop + the shared code it compiles |
| `npm run test:run` | Includes `tests/unit/desktop/*` (bridge, IPC validation, CSP, redaction, state migration, PKCE, RPC allowlist) and `tests/integration/desktop.test.ts` (RLS) |
| `ELISE_CLOUD_URL=… npm run package:desktop` | Packaged app in `desktop/out/` |
| `npm run smoke:desktop -- desktop/out/ELISE-win32-x64/elise.exe` | Boots with the cloud unreachable, with no remote request to render; bridge without Node; single instance; renderer crash recovery with the runtime alive |
| `npm run make:desktop -- --targets @electron-forge/maker-squirrel` | The real Windows installer: `desktop/out/make/squirrel.windows/x64/ELISE-Setup-<version>.exe`, plus `RELEASES` and the `.nupkg` the updater uses |
| `node desktop/scripts/installer-smoke.mjs "<Setup.exe>"` | Installs per user (no admin), checks `elise://` and the uninstall entry, launches, runs ELISE Home's requirements check (never the admin step), uninstalls |
| `tests/unit/desktop/home-runtime.test.ts` | The managed Home runtime with a fake backend: phases, progress, checksum, resume after restart, retry, update and rollback, reset |

## Configuration: where each variable goes

Desktop variables are **build-time** values, baked into the installer. Changing them afterwards
means building again. They're public by definition: server secrets are never read by the Desktop
build.

| Variable | Where | Value / meaning |
|---|---|---|
| `ELISE_CLOUD_URL` | Desktop build: GitHub Actions **Variable**, or `.env.local` for local builds | `https://elise-lime.vercel.app`. A packaged build **fails** if missing or local. Development defaults to `http://localhost:3000` |
| `ELISE_DESKTOP_CHANNEL` | Desktop build (CI derives it from the version: pre-release → `beta`) | `beta` / `stable` |
| `ELISE_UPDATE_FEED` | Desktop build (CI sets it) | `https://github.com/TheBotSpawner/elise/releases/download`. Unset: updates show as "unsupported", and nothing breaks |
| `NEXT_PUBLIC_SUPABASE_URL` / `_PUBLISHABLE_KEY` | Desktop build: GitHub Actions **Variables** | Same public values as the web (Realtime, uploads) |
| `ELISE_DESKTOP_MANIFEST_URL` | **Vercel** (web) | `https://github.com/TheBotSpawner/elise/releases/download/desktop-{channel}/desktop-releases.json`. Set once, never per release |
| `ELISE_DESKTOP_DOWNLOAD_CHANNEL` | Vercel (optional) | Forces `beta`/`stable` for everyone; otherwise production shows beta only to `ELISE_ADMIN_EMAILS` |
| `ELISE_ADMIN_EMAILS` | Vercel | Beta testers (they see beta downloads) |
| `ELISE_HA_URL`, `HA_TOKEN` | Your shell, development only | An existing Home Assistant for unpackaged builds. Not needed to install or sign in |

Trigger.dev uses none of these.

## ELISE Home runtime (ADR-082)

- **What runs:** Home Assistant Container, pinned by digest, under Podman, in ELISE's own WSL2
  distro `ELISE-Home`, with mirrored networking. It listens on 127.0.0.1 only.
- **What ELISE needs:**
  - Windows 11 22H2+ on x64, 4 GB RAM (8 GB recommended) and 12 GB free disk;
  - virtualization on in firmware;
  - WSL 2.

  WSL is turned on by ELISE: one administrator prompt at that step, usually one restart, and
  setup resumes afterwards. Windows 10 can run Desktop but not ELISE Home (no mirrored
  networking).
- **Where things live** (`%APPDATA%\ELISE\home-runtime\`):
  - `state.json` — phase, release, enabled; no secrets;
  - `downloads/` — the verified base artifact (resumable `.part` files);
  - `distro/` — the WSL disk (`ext4.vhdx`), holding the engine and its config at
    `/var/lib/elise-home/config`;
  - `backups/` — configuration tarballs taken before each engine update;
  - `wslconfig.backup` — the person's original `.wslconfig`, restored when Home is removed.

  The engine's credentials (ELISE's own token and owner password) are in `secrets.bin`
  (OS-encrypted), next to the session and hub credential.
- **Releases:** an allowlist in `desktop/src/runtime/home-runtime/releases.ts`, with the base
  pinned by SHA-256 and the engine by digest. To move to a newer Home Assistant:
  1. add a release with the new digest (look it up for the `stable` tag on ghcr.io);
  2. ship a Desktop update.

  The manager backs up, swaps and rolls back on failure.
- **Development:** `ELISE_HA_URL` + `HA_TOKEN` (unpackaged builds only) use an existing engine
  instead.
- **Remove:** Settings › ELISE Desktop › Configuración avanzada › "Quitar ELISE Home de esta
  computadora". This unregisters the distro, deletes its data and restores `.wslconfig`.

## Artifacts

| Path | What |
|---|---|
| `desktop/out/ELISE-win32-x64/` | The **unpacked** app, from `npm run package:desktop`. For development and `smoke:desktop`; **never** a download |
| `desktop/out/make/squirrel.windows/x64/ELISE-Setup-<version>.exe` | The **Windows installer**, from `npm run make:desktop -- --targets @electron-forge/maker-squirrel`. This is what people get |
| `…/RELEASES` + `…/elise_desktop-<nuget-version>-full.nupkg` | The Squirrel update feed: what the updater consumes |

## Download (web)

`/download/desktop` and Hogar read one manifest per channel through `ELISE_DESKTOP_MANIFEST_URL`
(`{channel}` → `beta` / `stable`). It's the asset `desktop-releases.json` of the fixed release
`desktop-<channel>`. The URL never changes; the release workflow rewrites the content.

- **Beta** (unsigned, internal) is shown in production only to `ELISE_ADMIN_EMAILS`, and to
  everyone outside production. Everyone else sees signed stable builds only.
- Drafts and withdrawn versions are never offered.
- Caching: the web caches each manifest for 5 minutes, so a new release shows up within minutes
  with no redeploy.

## Release (ADR-084)

1. Bump `desktop/package.json` `version` (the only Desktop version source; SemVer). Examples:
   `0.1.0-beta.2` (beta), `0.1.0` (stable). The bridge and runtime protocols are separate
   constants in `src/core/platform/platform.ts`.
2. Commit, then tag `desktop-v<version>` and push the tag.
3. The **ELISE Desktop** workflow (Windows):
   - builds the installer with the production Cloud (`ELISE_CLOUD_URL` Actions Variable);
   - runs the installer smoke test (install → launch → Cloud check → uninstall);
   - runs `desktop/scripts/publish-release.mjs`: the versioned release, a verified download
     (SHA-256), the channel's update feed, then the channel manifest **last**. A failure leaves
     the active manifest untouched.
4. **Stable** requires signing: Actions Secrets `WINDOWS_CERTIFICATE_BASE64` and
   `WINDOWS_CERTIFICATE_PASSWORD`. Unsigned builds can only go to beta.
5. **Rollback:** Actions → ELISE Desktop → Run workflow → version + channel. That version is
   marked withdrawn; the web and the updater go back to the previous good release. Fix forward
   with a higher version, and never re-use one.

Locally (same tooling): `npm run make:desktop -- --targets @electron-forge/maker-squirrel`, then
`node desktop/scripts/publish-release.mjs --channel beta --dry-run` shows what would be
published. A real publish needs the tag pushed (the release must match committed code).

## Lifecycle and data

- **Closing the window** keeps ELISE in the tray, and Home keeps running. **Salir de ELISE**
  stops the runtime cleanly, then quits.
- **Start at login** (packaged builds only) opens ELISE in the background (`--background`): no
  window, Home running.
- **A second launch** focuses the first instance and passes any `elise://` link to it. There is
  only ever one runtime.
- **Local data** lives in the OS app-data folder (`%APPDATA%\ELISE`,
  `~/Library/Application Support/ELISE`):
  - `state.json` (versioned and migrated, never wiped on update);
  - `secrets.bin` (OS-encrypted session and hub credential);
  - `cache/<user>.<workspace>/` (allowlisted last-known screens);
  - `logs/desktop.log` (redacted JSON lines, rotated at 2 MB).
- **Sign out** revokes this session and deletes the session and that account's cache. The home's
  hub credential stays until Hogar unlinks it, so the household isn't orphaned. Local control
  requires someone signed in to that home's workspace.
- **Install** is per user under `%LocalAppData%\elise_desktop` (Squirrel; no admin). `elise://`
  and start-at-login point at the stable launcher `elise_desktop\elise.exe`, so they survive
  updates.
- **Uninstall** removes the app, `elise://` and start-at-login, and stops ELISE Home's engine.
  Local data (including Home's data) is kept for a reinstall; removing Home is its own explicit
  action.
- **Updates** stop the runtime cleanly before installing. Pairing, configuration and cache
  survive, so there's nothing to re-pair.

## Manual validation still owed

Automated today:
- packaged boot offline;
- bridge surface;
- single instance;
- crash recovery;
- the signed-in UI against a local cloud, including the cloud going away (cached Inicio with its
  age, banner).

Still owed by hand:

- **ELISE Home on a machine where admin and a restart are allowed** (ADR-082):
  - enable WSL;
  - provision the engine;
  - the first-run bootstrap;
  - **LAN discovery with a real Wi-Fi device**;
  - restart recovery;
  - uninstall/reinstall.
- **Windows:**
  - tray behavior;
  - start at login;
  - `elise://` from the browser (sign-in);
  - updates, which need a feed;
  - uninstall.
- **macOS:** everything, since it can't be built or validated from a Windows machine.
- **(Done 2026-10-19)** Sign-in and presence against production work with migrations
  `20261101000050_elise_desktop.sql` and `20261102000051_desktop_home_runtime.sql` applied.
