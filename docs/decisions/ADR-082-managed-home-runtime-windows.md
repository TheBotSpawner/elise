# ADR-082: Managed ELISE Home runtime on Windows — Home Assistant Container on ELISE-managed WSL2

**Status:** Accepted (2026-10-18), **pending one validation on real hardware** (see
"Validation owed"). It resolves ADR-081's open decision and builds on ADR-079/080.

## Context

People should go from ELISE Web to Hogar, then "Descargar ELISE Desktop", install **one
product**, and end with their devices. They should never install Home Assistant, Docker
Desktop, VirtualBox, WSL tools, Python or a CLI, and never see port 8123, YAML, entity ids or
tokens. Home Assistant is ELISE's internal engine.

Home Assistant's supported installation types are **Home Assistant OS** and **Home Assistant
Container**. Core and Supervised were deprecated in 2025 (release 2025.6 started warning;
support ended with 2025.12), so they can't be ELISE's foundation. The target is Windows 11 x64,
Home and Pro editions.

## Options evaluated

| Criterion | A · HA OS in a managed VM | B · HA Container in ELISE's own WSL2 distro |
|---|---|---|
| No separate user install | Needs a hypervisor: Hyper-V (**Pro/Enterprise only**) or VirtualBox, a third-party product with its own kernel drivers | WSL is a **Windows component**, turned on by ELISE with one admin prompt |
| Windows 11 Home | ✗ without VirtualBox | ✓ |
| Windows 11 Pro | ✓ (Hyper-V) | ✓ |
| LAN, mDNS, SSDP | Hyper-V needs an External virtual switch bound to the right NIC (admin, fragile on Wi-Fi); the default switch is NAT, so no discovery | WSL **mirrored networking** (Windows 11 22H2+) puts the engine on the host's interfaces; Microsoft documents multicast support in this mode. ELISE adds narrow Hyper-V firewall rules for UDP 5353 and 1900 |
| Setup friction | VM creation, disk image (~1 GB+), switch setup | One admin prompt, usually one restart, then automatic |
| Download size | HA OS image ≈ 0.5 GB compressed, then updates inside | Base 3.7 MB (Alpine minirootfs) + Podman (apk) + HA image ≈ 0.6 GB compressed |
| RAM / disk | Fixed VM allocation (≥ 2 GB RAM), virtual disk | WSL's dynamic memory; one VHDX that grows |
| Updates | Supervisor updates itself | ELISE owns them: a pinned engine digest per runtime release, backup + rollback |
| Apps / add-ons, Supervisor | ✓ | ✗ (Container has no Supervisor). Acceptable: ELISE is the product, not HA's app store |
| Future USB (Zigbee, Thread radios) | Passthrough via the hypervisor | usbipd-win (Microsoft-sponsored OSS) attaches USB to WSL: later work |
| Bluetooth | Passthrough, fragile | Not in v1 (the engine runs without D-Bus/BlueZ access) |
| Safe uninstall | Delete the VM and its switch | `wsl --unregister ELISE-Home`; `.wslconfig` restored from ELISE's backup |
| Redistribution | HA OS image (Apache-2.0), plus the hypervisor's license (VirtualBox base is GPLv3; its Extension Pack is not freely redistributable) | Alpine (mixed OSS), Podman (Apache-2.0), HA (Apache-2.0); all pulled from their official sources, nothing re-hosted |

## Decision

**Option B.** On Windows, ELISE Home's engine is the official **Home Assistant Container**,
pinned by OCI digest. It runs with Podman inside an **ELISE-owned WSL2 distro (`ELISE-Home`)**
in **mirrored networking** mode.

Option A fails "Windows 11 Home without a third-party product", which is a hard requirement.
B keeps the same Home Assistant application and the same `home.*` contract. The tradeoff,
that ELISE owns updates and has no add-ons, is acceptable.

- **The runtime manager** (`desktop/src/runtime/home-runtime/`) runs in the Local Runtime
  process, independent of any window.
  - States: `not_installed`, `checking_requirements`, `requirements_missing`,
    `restart_required`, `downloading`, `verifying`, `installing`, `starting`, `ready`,
    `degraded`, `stopped`, `updating`, `error`.
  - Every phase is persisted, so a crash or reboot resumes setup. Downloads resume over HTTP
    Range.
  - Errors are `HOME_RUNTIME_*` codes mapped to plain ES/EN copy.
  - Health is watched, with bounded automatic restarts.
  - The renderer only sees phases, never VM or container commands.
- **Supply chain:**
  - The allowlist of runtime releases ships inside the signed app and is never fetched.
  - The base is downloaded over HTTPS and SHA-256 verified before use.
  - Packages come through `apk`, which verifies signatures.
  - The engine is pulled **by digest** (`ghcr.io/home-assistant/home-assistant@sha256:…`,
    2026.10.2 today).
  - Nothing user-provided is ever downloaded or run.
- **Prerequisites, checked before any large download:**
  - Windows 11 22H2 or later (build 22621+), on x64;
  - at least 4 GB RAM (8 GB recommended);
  - 12 GB free disk;
  - virtualization enabled in firmware;
  - WSL 2.

  WSL is the only one ELISE fixes itself: **one UAC prompt at that exact step**
  (`wsl --install --no-distribution` plus the two firewall rules), then
  **"Reiniciar ahora / Más tarde"**. The app never restarts on its own, and setup resumes after
  the restart. Missing anything else is said plainly and never attempted.
- **Network and security:**
  - mirrored networking is set in `%UserProfile%\.wslconfig`. It's global to WSL, so the
    original file is backed up and restored when Home is removed;
  - the engine listens on **127.0.0.1 only** (`http.server_host`). ELISE is its only client, and
    nobody on the LAN can onboard it first.
- **First run, with no tokens copied by hand.** ELISE becomes the engine's owner through Home
  Assistant's onboarding API (`/api/onboarding/users`, `core_config`, `analytics`,
  `integration`, the endpoints the HA frontend uses, verified in the pinned release's source).
  It then mints its own token with the documented `auth/long_lived_access_token` WebSocket
  command. Token and owner password go straight to Desktop's OS-encrypted store. The owner
  password exists only for a future "Abrir motor local" (advanced), which is not exposed in v1.
- **Lifecycle:**
  - Home starts whenever ELISE starts, including at login, in the background.
  - Closing the window never stops it. "Salir de ELISE" stops the engine cleanly.
  - Uninstalling ELISE stops the engine but keeps its data for a reinstall. Removing it is an
    explicit action ("Quitar ELISE Home de esta computadora").
- **Desktop itself never depends on Home.** If virtualization is missing, the download fails,
  or Home is never enabled, ELISE Desktop works normally.
- **Other hosts:**
  - macOS and Linux report "unsupported host" for now;
  - development can point at an existing engine (`ELISE_HA_URL` + `HA_TOKEN`, unpackaged builds
    only).

## Consequences

- **Windows 10 isn't supported for ELISE Home.** It has no mirrored networking, so under NAT
  the engine can't discover LAN devices. Desktop itself still runs there.
- ELISE owns engine updates. A new runtime release (new engine digest) ships with a Desktop
  update. The manager backs up the configuration, swaps the engine, and rolls back on failure.
- **The future ELISE Home Hub hardware** runs the same engine and the same Hub agent and cloud
  contract (`home.*`, rooms, devices, modes, commands). Only the host changes: a mini computer
  that stays on, so the PC no longer has to.

## Validation owed (honest status)

Automated on a real Windows 11 Pro machine:
- the real Squirrel installer (per-user install, `elise://` on the stable launcher, uninstall
  entry, launch, clean uninstall);
- the real requirements check, which correctly found only WSL missing;
- the Desktop and web setup flows.

Not yet done, because it needs a machine where admin rights and a restart are allowed:
- turning WSL on;
- provisioning the distro and engine;
- the first-run bootstrap against a live engine;
- **LAN discovery (mDNS/SSDP) with a real Wi-Fi device**;
- recovery after a Windows restart;
- uninstall and reinstall with Home.

The decision is final only after that run. If mirrored networking turns out not to carry
discovery reliably, this ADR gets revisited, with Hyper-V plus an external switch for Pro as
the fallback.
