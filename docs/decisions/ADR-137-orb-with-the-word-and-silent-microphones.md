# ADR-137: the corner Orb comes up with the word, and a silent microphone doesn't pass for one

**Status:** Accepted (2026-11-04). Refines ADR-095, ADR-102 and ADR-108.

## Context

The owner reported that, with ELISE in the background, saying "ELISE" took very long to bring up the
Orb, or didn't bring it up at all. Desktop's local log (2026-10-30 to 11-04) and the code showed three
causes:

- **The Orb waited for the end of the sentence.** "In conversation" was reported only after the
  capture ended: the person's whole request plus 2 s of quiet. With ADR-131's 60 s limit that could be
  a minute, and the Orb then opened on the state the last conversation left.
- **The microphone died without notice.** For 2.4 hours in three spells ELISE repeated the same cycle:
  "listening" for exactly 15 s, "no microphone" for 30 s. The microphone opened normally and delivered
  nothing; Chromium ends such a track after 15 s. Today's spell began on unlocking the computer, another
  after an hour and a half of listening fine. Two ended only when the app restarted; one ended by itself.
- **The status went back to "listening" between the capture and the hand-off**, for an instant.

## Decision

1. **The Orb comes up with the word.** Every accepted candidate brings up the corner Orb, listening,
   while the person is still talking, and it shows "thinking" during the transcription. This includes
   guarded candidates: ADR-108 keeps them silent, not invisible.
2. **A tap on it during the capture drops the capture.** Nothing of it is transcribed.
3. **Five seconds without a single audio frame is a dead microphone.** Counted in one-second ticks, so
   waking from sleep isn't mistaken for it. It's retried after 2 s, three times, then every 30 s as before.
4. **A dead microphone restarts Chromium's audio service**, at most once a minute and never during a
   conversation or with ELISE's music playing. Chromium brings the service back when it's next needed.
   Tried on Electron 44: a new microphone delivers audio, and an open `AudioContext` suspends and comes
   back with `resume()`, which every ELISE sound already calls before playing.

## Consequences

- A false alarm is now seen sooner and for longer: the Orb stays until that capture ends, up to 60 s in
  a room where people keep talking. A tap dismisses it. If it bothers, the guarded candidates are the
  ones to keep hidden again.
- It isn't proven that the audio service is what hangs: restarting the app fixed it, but that restarts
  everything. `desktop_audio_reset` in the log, followed by "listening" with no more "no microphone",
  will tell. If it doesn't help, the next step is restarting ELISE by itself while nobody uses it.
- A microphone that's really dead now opens and closes three more times in its first half minute.
