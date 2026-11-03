# ADR-130: Every wake candidate is transcribed before anything starts

**Status:** Accepted (2026-11-03). Revises ADR-095 §3 and ADR-108 §4.

## Context

The owner reports ELISE Desktop waking during meetings and classes on unrelated words. Reading the
hand-off (`desktop-wake.tsx`) showed three ways past the transcription check:

- **"Nothing after the word" skipped it.** The check ran only when `capture.speechAfter` was true.
  That flag uses the "speech" bar (3× the room, at least 0.012 RMS). The recognizer hears from a
  much lower bar (ADR-108: 2× the room, at least 0.0035). So a voice from speakers or across the
  room reaches the recognizer yet doesn't count as speech, and the capture looks like a bare word.
- **An empty transcript passed**, and so did a failed one.
- **Each of those counted as a confirmed call.** The session opened and listened to the meeting,
  and `confirmed()` lifted the guard ADR-108 built for exactly this case.

This comes from reading the code. No real meeting was measured: diagnostics stay on the device.

## Decision

1. **Every candidate is transcribed**, the bare word included. Only a transcript the name opens
   (`wakeVerdict`, `src/core/voice/wake.ts`) starts a conversation or lifts the guard. Over her
   reply the name may come later (ADR-109).
2. **An empty transcript is not a call.** It counts as a rejection, so detection gets guarded.
3. **An unreadable capture (failed transcription) starts nothing.** It isn't evidence of a false
   alarm, so it doesn't guard. If the chime was heard, the error tone answers it.

## Consequences

- A bare "ELISE" now waits for one transcription before the session listens, on top of the 1.4 s
  of silence that closes the capture. The chime is unchanged. Something said after that silence and
  before the session opens can lose its start. Needs a manual check.
- A real bare "ELISE" that the transcription mishears ("Elisa") is now rejected, as it already was
  when followed by words.
- The first false candidate of a meeting can still chime. After it, detection is guarded: silent
  until a transcript confirms. Each rejection extends that by 3 minutes.
- **Known, not changed:** the transcription's hints include ELISE's own names, which can tilt a
  doubtful capture toward the name.
