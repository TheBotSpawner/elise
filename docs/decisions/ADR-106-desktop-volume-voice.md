# ADR-106: "ELISE, subí / bajá el volumen" on Desktop

Status: accepted (2026-10-21). Extends ADR-102 and ADR-104 (spoken session commands).

## Decision

"Subí el volumen", "bajale un poco el volumen", "más volumen" and "menos volumen" move the
computer's volume a few points on ELISE Desktop. The English forms work too ("turn the
volume up", "louder").

- **Deterministic.** The phrase is matched by `sessionCommand` (`volume_up` /
  `volume_down`) and only when the whole utterance is the command. It never reaches the
  agent and never waits on a model.
- **What it does not catch.** If the phrase names a device or the music ("subí el volumen de
  la tele", "bajá la música"), it is not this command. It goes to ELISE, which controls the
  home and the music player.
- **Where it runs.** On the wake path, "ELISE, bajá el volumen" adjusts the volume and
  nothing else starts. Inside a speech-pipeline conversation it adjusts the volume and the
  conversation continues. On the web there is no computer volume, so the phrase stays an
  ordinary request. A GPT-Live session delegates it like any other request.
- **How.** A typed bridge call `adjustVolume("up" | "down")` (zod-validated, from ELISE's
  page only) runs a fixed command with no page text in it.
  - Windows: 5 presses of the volume key (2 points each, about 10 points), so Windows'
    volume indicator shows.
  - macOS: `osascript` moves the output volume by 10.
  - Other platforms: nothing happens.
