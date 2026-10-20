# ADR-103: Devices found on the network wait for "Agregar"

**Status:** Accepted (2026-10-20). Refines ADR-090 (adding home devices).

## Context

Hogar showed "FlowBox-F2" and "FlowBox-Z4" under the person's devices, though they never added
them. ELISE's sync (`hubSync`) listed every device in the home engine's registry. Some
integrations register devices by themselves: once Google Cast is set up (for "TV Living"), every
other Cast device on the network joins it. Being near a device doesn't make it the person's.

## Decision

- **Model (migration 060, additive).** `home_devices.added_at`: null means the device was found
  but not added. Every device already listed is backfilled as added. New rows from the sync have
  none.
- **Only added devices are the person's.** They are the only ones `homeSnapshot` returns as
  `devices`, which covers the Hogar list, voice and chat tools, modes and commands. The rest go to
  `found` (not hidden, not removed).
- **Hogar shows them separately.** "Encontrados en tu red" appears on the dashboard and in the
  add-devices step, with "Agregar" (sets `added_at`) and "Ignorar" (hides it; not offered again).
- **Right after a setup the person finished.** When ADR-090's flow ends with "Agregado", Hogar
  adopts what the engine registered from 15 s before that moment, at 6 s and 23 s (the agent
  resyncs at 4 s and 20 s). It covers at most ten minutes back and never touches ignored
  devices. Anything the engine finds later waits.
- **A device the person removed that comes back** is found again, not silently re-added.
- **Graceful rollout.** Without migration 060 the column is absent and every device counts as
  added, which was the previous behavior.

## Consequences

- Devices auto-registered before migration 060 (the FlowBoxes today) were backfilled as added, so
  they stay listed: the migration can't tell them apart. Remove them once with "Quitar", or with
  "Ignorar" if they come back.
- Siblings that an integration registers in the same seconds as a device the person just added
  are adopted with it. Telling them apart needs the engine to say which device a setup created.
