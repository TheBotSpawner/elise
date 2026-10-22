# ADR-110: Infrared through a Broadlink

**Status:** Accepted (2026-10-22). Extends ADR-079, ADR-082 and ADR-090.

## Context

Many TVs, air conditioners and fans only take infrared. A Broadlink RM4 mini or RM4C mini on
the home network can learn and send those codes. Home Assistant supports both models through its
`broadlink` integration:

- `remote.learn_command` waits up to 30 s for a button press and stores the code under a device
  and command name;
- `remote.send_command` sends a stored code by those names;
- `remote.delete_command` removes one.

No API lists stored codes. Learning is ignored silently while the remote entity is off.

Infrared has no feedback, so ELISE can't read a device's state back.

## Decision

1. **Controller vs controlled device.**
   - The Broadlink is synced by the hub like any device, as the new type `ir_controller` with
     the `ir_blaster` capability. Only `remote` entities from the `broadlink` platform qualify.
   - The TV, air conditioner or fan is ELISE's own device, created by the person: a
     `home_devices` row with `provider_key = 'ir:<uuid>'`, typed as `media_player`, `climate`,
     `fan` or `switch`.
   - It has one `ir` capability: the controller's id, a regex-safe name for the controller
     (`elise_<12 hex>`), the kind, and the learned buttons. Each button has a key, label,
     verified flag and, for an AC, its preset.
   - A sync never removes `ir:` rows, and a hub can't report `ir:` keys.
2. **Learning is local only.** The path is Hogar on Desktop → main process (owner check,
   zod) → local runtime → hub agent → `remote.learn_command`. The agent:
   - re-validates the names;
   - requires a controller it reported;
   - allows one learning at a time per controller;
   - turns the remote entity on if it was off;
   - waits 45 s on the WebSocket.

   It reports only `ok` or a reason: `no_signal`, `busy`, `offline`, `not_found` or
   `bad_name`. The engine's token and the codes never leave the computer. The web says to
   open Desktop.
3. **A button is "works" only after the person says so.** Learn → save unverified → send once
   through the normal command path → "¿El equipo reaccionó?" → verified or not. Learning again
   overwrites the same name in the controller.
4. **Sending** is the normal path:
   - the cloud validates `button`, `power`, `volume` and the other actions against the `ir`
     capability, producing an `ir` action (`device`, `command`, `repeats` 1–10);
   - `hubClaimCommands` aims the command at the device's controller, which must be on the same
     hub and in the same workspace;
   - the hub accepts `ir` actions only on an `ir_controller` it reported, and never mixed with
     other actions, then calls `remote.send_command`;
   - the adapter refuses `ir` actions on any other domain.
5. **Honesty rules (`validateIr`):**
   - A single toggle power button is never "on" or "off": ELISE says why and asks before
     pressing it.
   - Volume moves only by steps (+10 → 2 presses); an exact level is refused.
   - An AC takes only presets the person captured (mode + temperature + optional fan, from one
     press of its remote). "Poné el aire a 24" works only if 24 was captured in that mode;
     otherwise ELISE lists what exists.
   - After a send, the state is `estimated` with `lastSent`; a toggle leaves on/off unknown.
   - Broad commands ("apagá todo") never include infrared devices.
6. **Adding a Broadlink.**
   - It is found like any device (ADR-090).
   - When it isn't, the person can add it by address. The hub starts the `broadlink` config
     flow through the same REST exception as ADR-090, with a fixed handler. `lanHost` accepts
     only private IPv4 or a local host name; no URL, port, public IP or loopback. The rest
     (unlock, name) uses the existing step form.
7. **Quick setup by profile:** not shipped. No profile source is verifiable today. SmartIR
   needs HACS and a custom component, so ELISE won't install it or change the engine without
   consent. The person is told so and learns from their own remote.
8. **Database:** migration 063.
   - Adds `ir_controller` to the type check and raises the capabilities limit to 16 kB.
   - Adds an insert policy: members only, `ir:` keys only, and only on a hub that has an
     `ir_controller` in the same workspace and home.

## Consequences

- Scenes mix Wi-Fi and infrared: an infrared device takes one learned button per scene.
- Voice and chat use the existing `home.*` tools. "Subí el volumen" alone is still the computer
  (ADR-106); naming the TV goes to Hogar.
- Learned codes stay in the engine's storage when an infrared device is removed. They are
  harmless and never reused, since names are per device. They are never edited by hand.
- If the hub is paired again, its controllers get new rows and existing infrared devices show
  as unavailable until they are recreated.
- No local (cloud-down) sending for infrared yet.
- Pending until hardware arrives: a real RM4 mini or RM4C mini, learning range and timing,
  AC remotes' full-state behavior, the unlock step.
