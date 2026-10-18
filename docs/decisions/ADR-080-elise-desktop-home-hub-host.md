# ADR-080: ELISE Desktop hosts the Home Hub on a PC

**Status:** Accepted (2026-10-18). Builds on ADR-079.

## Context

ELISE Home needs something always on at home that can reach local devices. A browser tab can't
be that: it closes, it can't reach the local network, and it doesn't run when the screen is off.

## Decision

- **Topology:** in the PC phase, the hub lives inside ELISE Desktop. Its parts:
  - **ELISE Home Service:** the background service (the `home-hub/` loop).
  - **Managed Home Assistant runtime:** installed, started, health-checked and upgraded by the
    service.
  - **ELISE Desktop UI shell:** kept separate from the service, so closing or crashing the window
    never stops the hub.

  Browser and phone are interfaces to the same `home.*` capability; there's no Desktop-only API.
- **One installation.** People install ELISE Desktop and nothing else. Home Assistant is an
  internal engine: its dashboard, YAML, entity ids, port 8123, containers and tokens never
  appear in normal UX, only under Advanced / Diagnostics as "Motor local".
- **Detection comes from authenticated presence.** The browser never guesses whether Desktop is
  installed (no user-agent heuristics, no probing). `homeSetupState()` derives the state from
  the hub's heartbeat:

  | State | When |
  |---|---|
  | `desktop_not_configured` | no hub |
  | `desktop_offline` | heartbeat older than 75 s |
  | `desktop_update_required` | protocol version below the minimum |
  | `hub_initializing` | the local runtime is starting |
  | `hub_error` | the local runtime is failing |
  | `desktop_online` | online, nothing synced yet |
  | `hub_ready` | online, provider connected, devices synced |

  Hogar follows it live through Realtime: when Desktop comes online, setup advances without a
  refresh.
- **Pairing:**
  - Desktop is signed in to ELISE, so it calls `POST /api/home/desktop/register` with the
    person's session and receives a hub-only credential once. The user copies nothing, and the
    session never reaches the hub.
  - The single-use pairing code (ADR-079) remains for the development agent and future
    hardware.
- **Download:** `/download/desktop` recommends the build for the browser's OS, lists the others,
  explains in one sentence why Desktop is needed, and returns to Hogar.
  - Builds come from `ELISE_DESKTOP_RELEASES`: platform, architecture, version, an https URL,
    and optionally a minimum supported version.
  - With none configured, the page says Desktop isn't available yet. No fake binaries.
- **Deep link:** `elise://home`, `elise://home/setup` and `elise://home/diagnostics` are a
  convenience to open Desktop. They're never the installation detector, and if Desktop doesn't
  open, the page offers the download.
- **Desktop v1 responsibilities** (separate milestone; the framework is chosen then):
  - authenticated client and chat/voice;
  - tray or menu-bar presence;
  - auto-start ("Iniciar Home Hub al encender la computadora", on with Home setup, reversible);
  - the background Home Service as a Windows service or startup app, or a macOS login item;
  - the managed runtime and local-network permissions;
  - updates and diagnostics;
  - secrets in the OS keychain.

  The runtime should use a Home Assistant installation mode that's supported for the commercial
  target. It isn't chosen here.
- **Hardware later:** a dedicated ELISE Home Hub, or a Raspberry Pi, runs the same service and
  the same protocol (`HOME_PROTOCOL_VERSION`) with `host_kind = hardware`. Cloud, capability
  and UX don't change.
- **Future voice satellites** (per-room microphone and speaker) attach to the hub, not to the
  cloud contract.
