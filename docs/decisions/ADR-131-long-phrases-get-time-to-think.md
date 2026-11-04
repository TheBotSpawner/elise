# ADR-131: ELISE listens until 2 seconds of silence

**Status:** Accepted (2026-11-03). Replaces ADR-036's short silence for a complete phrase and
ADR-095's wake capture timing.

## Context

The owner reports ELISE cutting them off mid-sentence, and proposed waiting for 2 s of silence.

- **Session.** A turn ended after 0.7 s of silence when the provisional transcript sounded complete,
  and the recognizer closes every pause with a period, so nearly everything did. Otherwise 1.1 s.
- **Wake capture ("Elise, …").** It ended at 0.9 s of quiet and at 9 s in all.
- **A first fix wasn't enough.** Waiting 1.5 s only after 3 s of voice still cut them
  ("si el domingo tengo una carrera y ayer corrí 14 kilómetros…").

Exceptions for short or "complete" phrases were considered and left out. The transcript's period
says nothing, a short phrase can be the start of a long one (that example opens with "si"), and a
cut costs the whole request while the wait costs under a second or so.

## Decision

1. **One rule: 2 s of silence end a turn**, whatever was said and however long it was. A phrase that
   sounds unfinished keeps its 2.4 s.
2. **The wake capture follows it:** 2 s of quiet (16 frames of 128 ms), also for the word alone. Its
   limit is the session's: 60 s. A first 20 s still cut a dictated note.
3. **A request from the wake capture gets the tail** (ADR-036), like any other: in a continuous
   conversation, what's said in the next 4 s joins it.

## Consequences

- **Every reply starts later**, short commands too: up to 1.3 s on paper. Probably less, since the
  turn used to wait for the provisional transcript (taken at 0.45 s) and now it's ready by the end.
  Not measured. The instant line (ADR-125 addendum) also comes after the silence.
- "Silence" is measured by loudness. A voice that fades below the room's bar counts as silence, so
  a very soft ending can still run the clock. Not measured with real voices.
- A false wake candidate in a meeting can send up to 60 s to the transcription before it's rejected,
  and detection is off meanwhile. Audio isn't stored.
- **The instant line came back with an echo** (ADR-125 addendum): one word of it ("segundo") could
  pass as the person's continuation, since the echo check needed two. Over an acknowledgement, one
  word now counts.
