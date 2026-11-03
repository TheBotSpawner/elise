# ADR-131: A long phrase gets time to think

**Status:** Accepted (2026-11-03). Adjusts ADR-036 (turn end) and ADR-095 (wake capture).

## Context

The owner reports ELISE cutting them off mid-sentence, on a long request ("en mi correo personal
vas a ver dos turnos nuevos que son uno de traumatología…"). This comes from reading the code; which
path cut that request isn't recorded, and no real timing was measured.

- **Session.** A pause of 0.45 s starts a provisional transcript. The recognizer ends it with a
  period, so `looksComplete` says "complete" and 0.7 s of silence ends the turn. Without a verdict
  yet, 1.1 s does. A person thinking mid-explanation pauses that long.
- **Wake capture ("Elise, …").** It ended at 0.9 s of quiet and at 9 s in all, with no transcript
  to consult.
- **No way back on the wake path.** The tail that joins what's said next (ADR-036) needs continuous
  conversation, and a request from the wake capture never opens it.

## Decision

Patience depends on how much was said. Short commands keep their speed.

1. **Session:** after 3 s of voice, a pause ends the turn at 1.5 s, whether the verdict is complete
   or unknown. "Unfinished" keeps its 2.4 s.
2. **Wake capture:** after about 3 s of voice, 1.5 s of quiet ends it instead of 0.9 s. Its limit
   goes from 9 s to 20 s.

## Consequences

- A long request answers 0.4–0.8 s later. Short ones don't change.
- A false wake candidate in a meeting can now send up to 20 s to the transcription instead of 9 s
  before it's rejected. Audio isn't stored.
- A pause longer than 1.5 s still cuts on the wake path, since it has no tail. Not changed.
