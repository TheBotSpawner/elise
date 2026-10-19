# ADR-093: Opening apps on a TV

**Status:** Accepted (2026-10-19). Extends ADR-079 (Home capabilities).

## Context

"Abrime YouTube en la TV del dormitorio" went to Music: its guidance sent every "YouTube" there,
and `music.play` takes a `device`. The YouTube provider can't pick devices, so the person heard
"Eso todavía no está conectado". Home had no way to open an app: `source` only exists on TVs that
publish a source list, and Android TVs usually don't.

## Decision

- **A new Home capability and action, `app`.** `HOME_APPS` is a short list of known apps
  (YouTube, Netflix, Prime Video, Disney+, Max), matched by the words people use.
  - A TV that lists the app among its own sources switches to it with `source`.
  - Otherwise the Home Assistant adapter opens it by link (`play_media`, type `app`, using the
    links Home Assistant documents).
  - Only `androidtv_remote` TVs get `app`. Cast players read `play_media` differently.
- **Routing.**
  - Music's guidance says a TV of the home is never `music.play`'s device.
  - Home's guidance and `home.control` carry the example.
  - If the model still asks Music for a device, the error points to `home.control` instead of
    "not connected".
- **Opening an app, not choosing a video.** Playing a specific video on a TV is out of scope for
  now.

## Consequences

- Devices get the `app` capability on the hub's next sync. That needs the ELISE Desktop release
  that ships this agent.
- A TV that drops off Wi-Fi when turned off shows as "No responde" and can't be turned on
  remotely. The device sheet explains how to enable network power-on.
