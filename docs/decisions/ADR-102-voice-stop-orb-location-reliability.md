# ADR-102: Spoken stop, a reliable background Orb, and location that sticks

**Status:** Accepted (2026-10-20). Extends ADR-095 (Desktop wake word), ADR-023/028 (location) and
ADR-086. It supersedes part of ADR-095 §5: the Orb shows on the screen in use, in the chosen corner.

## Context

Three problems were reported from real use of ELISE Desktop on Windows:

1. **The Orb sometimes didn't appear** after a wake from Chrome, or after Windows started. ELISE
   heard and answered, but nothing showed. Causes found:
   - The Orb was placed once, on the primary display's work area as it was at creation. At
     login, scaling, the taskbar and monitors are still settling, and with two monitors it sat on
     the one the person wasn't looking at.
   - A page that failed to load, or a renderer that died (a GPU reset), left an invisible
     transparent window. Nothing recreated it.
   - It was raised only at the "floating" level and never re-asserted, and "Show desktop" could
     minimize it.
   - It kept drawing frames while hidden, because the wake word's throttling switch applied to it
     too.
2. **There was no spoken way out.** "ELISE, dejá de escuchar" was sent to the agent as an ordinary
   request.
3. **ELISE kept asking where the person was** with "Usar mi ubicación actual" on, and an
   address-to-address route ("Conde 3095 → Ramón Falcón 3167") failed. Causes found:
   - Desktop's permission handler didn't allow `geolocation`, so every request was denied.
   - Measured on Windows (Electron 44), a first fix takes about 4.8 s, but a turn waited only
     3.5 s for one.
   - With no position and nothing on the map, the geocoder got no regional context. It returned
     `ZERO_RESULTS` for "Conde 3095" and for "Ramon Falcon 3167" (without accents), and Places
     search fell back to the server's IP region.

## Decision

1. **The Orb (`desktop/src/main/wake-orb.ts`).**
   - **Placement and z-order.** At every show, it is placed on the display under the pointer, in
     the chosen corner (`wakeOrbCorner`, Settings › ELISE Desktop). It moves when displays are
     added, removed or rescaled, and is shown inactive at the `screen-saver` level, then
     `moveTop()`. It is still `focusable: false` and can't be minimized. The main window is
     never shown or focused by any of this.
   - **Recovery.** A failed load or a dead renderer recreates it, up to three times in a row.
     After that, the wake chime is the only signal until the next conversation.
   - **Throttling.** It keeps background throttling, so it draws nothing while hidden.
   - **Trace (states only).** The main process logs `desktop_orb_shown` with a safe id, the
     milliseconds since the conversation started, whether it is visible, the display index and
     its scale. It also logs `desktop_orb_hidden`, `desktop_orb_tapped`, `desktop_orb_recreated`
     and `desktop_orb_moved`. Never audio, never words.
2. **Spoken session control (`src/core/voice/session-control.ts`).** A deterministic matcher
   runs before the agent, on the whole utterance. The wake word, "che", "por favor" and "ya"
   don't count; anything else around the command makes it an ordinary request.
   - **`stop`.** Examples: "dejá / pará / basta de escuchar", "silencio", "cortá la
     conversación", "basta". It ends the session: the microphone is released, playback stops,
     nothing is sent and no acknowledgement is spoken. The Orb hides, and the device goes back
     to waiting for "ELISE" locally.
   - **`disable_wake`.** Examples: "desactivá la activación por voz", "no vuelvas a escuchar
     hasta que te active". It also turns the persisted Desktop setting off. Settings or the tray
     ("Activar escucha de “ELISE”…") turn it back on, with consent. In a browser it turns off the
     wake phrase for that page.
   - **Where it runs.** It works for the words right after "ELISE" (no session starts, and an
     open one ends) and for any turn of a session in progress, including a barge-in while ELISE
     speaks.
   - **Limits.** Without the wake word, an idle detector can't hear a stop, because there is no
     local command spotting. "Anotá la frase 'dejá de escuchar'" is a request, not a command.
3. **Location.**
   - **Permission.** Desktop allows `geolocation` for its own pages. It is asked only when the
     setting is on, and Windows' permission still applies.
   - **Waiting for a fix.** A turn waits 3.5 s when there is a usable older sample, and 8 s when
     there is none. A fix that arrives later is kept for the next question (one fix in flight;
     coarse; memory only, as before).
   - **Regional bias.** With no position and nothing on the map, the city of the user's timezone
     biases the geocoder and Places (`regionBias`, cached like any geocode). It is a preference,
     never a filter. It never affects ranking or confidence, and is never said to be where the
     user is. Explicit places win: "10 Downing Street, London" stays in London.

## Consequences

- **Verified live through `location.getRoute` with Google** (2026-10-20):
  - "Conde 3095 → Ramón Falcón 3167" resolves both addresses in CABA, at high confidence: 10.2 km
    and about 143 min walking, 11.7 km and about 52 min driving;
  - the version without accents resolves the same;
  - London stays in London.
- **Transit stays Google's.** ELISE adds no GTFS data of its own and never invents stops or
  timetables.
- **What only a person can confirm.** That the Orb is visible above every app needs manual
  Windows checks: exclusive full-screen games and secure desktops (UAC, the lock screen) can't
  show it.
- **Desktop releases.** These changes reach users only with a new Desktop build. The web parts
  ship with the next cloud deploy.
