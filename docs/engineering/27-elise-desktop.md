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
| `npm run make:desktop -- --targets @electron-forge/maker-squirrel` | The real Windows installer: `desktop/out/make/squirrel.windows/x64/ELISE-<version> Setup.exe`, plus `RELEASES` and the `.nupkg` the updater uses |
| `node desktop/scripts/installer-smoke.mjs "<Setup.exe>"` | Installs per user (no admin), checks `elise://` and the uninstall entry, launches, runs ELISE Home's requirements check (never the admin step), uninstalls |
| `tests/unit/desktop/home-runtime.test.ts` | The managed Home runtime with a fake backend: phases, progress, checksum, resume after restart, retry, update and rollback, reset |

## Configuration (build time, public by definition)

| Variable | Meaning |
|---|---|
| `ELISE_CLOUD_URL` | ELISE Cloud base URL. Required to package; development defaults to `http://localhost:3000` |
| `NEXT_PUBLIC_SUPABASE_URL` / `_PUBLISHABLE_KEY` | Realtime and uploads as the signed-in person |
| `ELISE_UPDATE_FEED` | https base of the update feed (`<feed>/<channel>/<platform>/<arch>`). Unset means updates are "unsupported" |
| `ELISE_DESKTOP_CHANNEL` | `stable` (default) or `beta` |

Server secrets are never read by the Desktop build. Anything in the binary is public.

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

## Download (web)

`/download/desktop` and Hogar read **one manifest**, `ELISE_DESKTOP_MANIFEST_URL`: in
production that's the `desktop-manifest` release asset `desktop-releases.json`. It's built from
the same Forge output the updater serves.

- Drafts are never offered, and neither are withdrawn versions.
- `beta` builds show only where `ELISE_DESKTOP_DOWNLOAD_CHANNEL=beta`, or outside production.
- A **stable** download must be **signed**.
- Writing and editing it: `desktop/scripts/release-manifest.mjs`, which also handles
  `--withdraw <version>`. In CI, publishing a `desktop-v*` release adds it to the manifest, and
  "Run workflow" with a version withdraws it.

## Release

1. Bump `desktop/package.json` `version`. It's the only Desktop version source; the bridge and
   runtime protocols are separate constants in `src/core/platform/platform.ts`.
2. Tag `desktop-vX.Y.Z` and push. The **ELISE Desktop** workflow builds signed installers for
   Windows (Squirrel) and macOS (DMG + ZIP) and publishes a **draft** GitHub release.
3. Review the draft, then publish it.
   - Publishing is what puts the release on the update feed.
   - **Rollback:** don't publish a bad build, or unpublish it. The feed then keeps offering the
     previous version. Fix forward with a higher version; never re-use a version.
4. Signing secrets:
   - Windows: `WINDOWS_CERTIFICATE_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`.
   - macOS: `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
     `APPLE_TEAM_ID`.

   Repository variables: `ELISE_CLOUD_URL`, `ELISE_UPDATE_FEED`, `NEXT_PUBLIC_SUPABASE_*`.
   Unsigned builds are for development only.

The auto-updater is Electron's own (Squirrel and ShipIt). It needs a feed server, for example a
static bucket laid out per channel, platform and arch, or update.electronjs.org if the
repository is public. Choosing and hosting it is part of the first production release.

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
- **The whole sign-in flow and presence against production** need migrations
  `20261101000050_elise_desktop.sql` and `20261102000051_desktop_home_runtime.sql` applied.
