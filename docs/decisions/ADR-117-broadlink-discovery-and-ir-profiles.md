# ADR-117: Broadlink found by Desktop, and published IR profiles before learning

**Status:** Accepted (2026-10-23). Extends ADR-110 (infrared) and ADR-090 (adding devices).

## Context

A real Broadlink RM4C mini, set up and online in the BroadLink app, never showed in "Buscar
dispositivos". Adding it by IP worked.

**Root cause:**
- **Discovery is DHCP-only.** Home Assistant's `broadlink` integration declares only DHCP
  discovery in its manifest: the MAC prefixes plus `registered_devices`. No zeroconf or SSDP.
- **WSL2 can't see that traffic.** ELISE's engine runs inside WSL2, behind NAT, and never sees
  the home network's DHCP broadcasts. The device also only sends them when it joins or renews.
- **Other devices do appear.** TVs announce themselves over mDNS/SSDP, which reach the engine.

The person also had their TV and AC set up in the BroadLink app. **They can't be imported:**
- BroadLink keeps those remotes in its own cloud, with no documented export or API.
- Home Assistant doesn't read them either: the integration exposes the emitter, not the app's
  virtual remotes.

ELISE won't scrape the account or reverse-engineer the cloud.

## Decision

1. **Desktop finds Broadlinks itself.**
   - The local runtime runs on Windows, on the real network. It sends Broadlink's documented
     local hello: the python-broadlink `hello`, a UDP broadcast to port 80 with the time, the
     sender's address and a checksum.
   - It sends one per real interface, on private networks only, never on virtual adapters (WSL,
     Hyper-V, VPN). It waits 2.5 s.
   - Results are cached 20 s, and one scan runs at a time.
   - Replies give type, MAC, name and lock state.
   - Devices the engine already has, by MAC from the device registry, aren't offered again.
   - The rest appear in the same "Buscar dispositivos" list with "Agregar". That runs the same
     setup as "agregar por IP" with the address the device answered from, so nothing is typed.
     "Agregar por IP" stays as the fallback.
   - The model comes from python-broadlink's device table. An unknown type is shown as just
     "Broadlink", never guessed.
2. **What's offered is real.**
   - The router's UPnP/IGD gateway (`upnp`) isn't offered as a device.
   - The counter counts everything listed: the devices the engine registered by itself plus the
     pending setups.
3. **Profiles before learning.**
   - After creating a TV, AC or fan, ELISE says plainly that the BroadLink app's remotes can't
     be imported, and asks for the brand.
   - The source is SmartIR's public library (MIT): its index per device class and one JSON per
     profile, fetched from GitHub raw files and cached for a day. Only Broadlink/base64 profiles
     are used.
   - Nothing is installed in the engine.
   - A bounded subset of a profile's codes becomes the device's buttons, unverified:
     - **TV:** power, volume, mute, channels and up to 6 inputs.
     - **AC:** off, plus captured states by mode and temperature, most used first.
     - **Budget:** 11 kB of codes, inside the 16 kB capability row.
   - ELISE presses power and asks "¿Se apagó?". Yes marks it working; no tries the next
     candidate. If none works, or there's no profile, the fallback is learning only the needed
     buttons with the person's remote. "Omitir por ahora" is always available.
4. **Sending a profile's code.** An `ir` command may carry `code` (base64), set only by ELISE and
   never accepted from a client. The adapter sends it as the engine's documented raw
   `b64:<code>`. Learned buttons are still sent by name. ADR-110's honesty rules are unchanged:
   an AC takes only the states it has, and nothing is reported as set unless it was sent.

## Consequences

- The RM4C mini is found with no IP typed. A later IP change is followed on the next search.
- Profiles depend on SmartIR's coverage. Some brands sold in Argentina (BGH, for example)
  aren't in it, and those fall back to learning.
- Sending profile codes needs Desktop 0.1.0-beta.36 or later (the hub's command schema carries
  `code`). Older hubs drop it.
- No migration: the capability shape gains optional fields within the existing size check.
