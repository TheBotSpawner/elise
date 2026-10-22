# ADR-109: "ELISE" interrupts her own reply (Desktop)

**Status:** Accepted (2026-10-22). Extends ADR-095 and ADR-108.

## Decision

While ELISE thinks or speaks (`thinking`, `executing`, `speaking`), the Desktop wake detector
keeps listening for "ELISE" instead of pausing until the conversation ends. Echo cancellation
keeps ELISE's own voice out of what the detector hears.

When it hears the word:

1. **Her reply pauses at once.** The speech output context is suspended: what plays and what
   is queued freeze exactly where they are. The turn keeps arriving in the background. A
   validated candidate chimes, as in ADR-108.
2. **The capture is transcribed** as for any wake.
3. **The result decides what happens:**

   | Transcription | Effect |
   |---|---|
   | A new request ("ELISE, mejor decime el clima") | The reply ends (what was said stays on screen), the session rests, and the request opens the next turn. Nothing said after "ELISE" is lost, because the capture starts at the word |
   | The word alone | The reply ends and the session listens |
   | "Basta", "dejá de escuchar" | The reply ends and the conversation ends |
   | "Bajá el volumen", "mostrate" | The command runs and the paused reply goes on |
   | Not a call (the name didn't open it), a failed transcription, or offline | The reply resumes where it stopped |

4. **ELISE never interrupts herself.** If one of her own lines in the last 6 s contained her
   name, a detection is treated as her echo and dropped.

The ADR-108 arbiter rules apply as always: the word must open the utterance, finals need
confidence, and detection gets stricter after false alarms. Mid-sentence mentions therefore
don't pause her.

## Consequences

- Barge-in by voice no longer needs continuous conversation or the microphone barge-in setting
  on Desktop: saying her name is enough.
- A false detection costs a brief pause, not a lost reply.
- Not covered: GPT-Live sessions and the web, which have no device wake word. The web keeps its
  existing barge-in (ADR-017).
- Needs a manual check with speakers: echo cancellation quality varies by device.
