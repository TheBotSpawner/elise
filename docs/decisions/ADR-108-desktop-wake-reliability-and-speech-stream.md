# ADR-108: Desktop wake word reliability, and speech as one continuous stream

**Status:** Accepted (2026-10-22). Revises ADR-095 (wake word) and the output stage of ADR-030
(speech player). Report: `docs/engineering/31-desktop-wake-and-audio.md`.

## Context

- **Wake word.** ELISE Desktop was hard to wake from a distance or over music, yet it woke by
  mistake in meetings. Every Vosk partial result containing "elise" counted, even mid-sentence,
  and played the chime before the transcription confirmed anything.
- **Beeps.** Short electronic beeps were heard in the middle of spoken answers on Desktop.
  - The person's diagnostic export showed that the speech ELISE scheduled was clean.
  - Rendering the speech player's scheduling in ELISE Desktop's own Chromium (Electron 44.9,
    Chromium 152) showed the problem: one buffer source per network chunk clicked at chunk
    boundaries, and sometimes rendered a whole chunk with ~3× the high-frequency energy.
  - Desktop always uses this player, because the wake word hands over to the legacy session.
    Web voice uses GPT-Live when the deployment enables it, and then never goes through this
    player.

## Decision

1. **Speech is one continuous stream.**
   - The speech player pushes PCM into an AudioWorklet (`public/audio/pcm-stream-worklet.js`)
     in a context at the voice's own rate (24 kHz). The audio system does the one rate
     conversion, on a continuous stream.
   - There are no per-chunk start times and no per-chunk resampling.
   - Fades are short: 2 ms when audio starts or runs dry, 5 ms on an interruption.
   - Underruns are logged.
   - Where AudioWorklet is unavailable, the previous buffer scheduling remains as the fallback.
2. **Wake capture without an audio context.**
   - The microphone is read with `MediaStreamTrackProcessor`, so frames queue instead of being
     lost while the page is busy, and no extra output stream is opened.
   - Its native rate is converted to 16 kHz with the same filter the evaluation uses.
   - A change of audio device restarts listening on the new default device.
3. **A quieter energy gate.** The recognizer hears frames above max(2× room, -49 dBFS).
   Before it was max(3× room, -38 dBFS), which a normal voice at 1.5–3 m, or under music, often
   didn't pass.
4. **Candidate ≠ activation (`src/core/voice/wake-arbiter.ts`):**
   - The word must open what is being said, after at most one courtesy word, or follow a pause
     of ≥ 0.35 s in a final result.
   - A final result needs word confidence ≥ 0.55.
   - After the transcription rejects a candidate, detection is guarded for 3 minutes: partials
     don't count and finals need confidence ≥ 0.8. Two rejections within a minute pause
     detection for 20 s.
   - A confirmed call lifts the guard.
   - With ELISE's own music playing, partials don't count.
   - The chime plays at an unguarded acceptance. A guarded candidate stays silent until the
     transcription confirms it; a rejected one never sounds.
5. **The capture starts where the utterance started** when the word was confirmed from a
   partial, as far back as the 8 s ring allows, so the start of "ELISE, ¿qué tengo hoy?" is
   never cut.
6. **One context for chimes** instead of one per chime.
7. **Diagnostics**, local and in memory only, in the voice diagnostics export:
   - device (id hashed), rate and AEC/NS/AGC state;
   - levels every 2 s (RMS, peak, clipping, decoding share);
   - each candidate with source, confidence and the reason it was accepted or rejected;
   - transcription outcomes, output context rate and latency, state changes and underruns.
8. **Output check (Settings › Voz, Desktop):** 60 s of system audio, recorded on the person's
   click only.
   - The main process allows that one capture for 10 s, from ELISE's page only.
   - The recording is analyzed on the device (`src/core/voice/beep-detect.ts`). Each beep is
     classified as ELISE's chime, already in the generated voice, added after ELISE, or not
     ELISE.
   - Nothing leaves the device unless the person downloads the report. The recording itself is
     downloaded only if they tick it.
9. **A reproducible evaluation:**
   - `desktop/scripts/wake-eval/` runs the shipped model on a synthetic Rioplatense corpus under
     simulated distance, music and meetings.
   - `tests/unit/voice/wake-eval.test.ts` replays the recognizer traces through the shipped
     rules. It fails if v2 detects less than v1, makes more false activations, is slower, or
     loses the start of a request.

## Consequences

- **Measured on the synthetic corpus** (real model, simulated rooms; a proxy):

  | | v1 (before) | v2 |
  |---|---|---|
  | Calls detected | 56.7 % | 70.8 % |
  | False candidates per hour of meeting talk | 60 | 8 |
  | Audible false chimes per hour | 60 | 2 |
  | Latency (median / p95) | 0.69 s / 1.33 s | 0.69 s / 1.20 s |

- The recognizer now decodes more often in a noisy room: 69 % of frames on the corpus, against
  45 % before. That is more CPU in noise; it was not measured on hardware.
- Meeting babble at a distance is still hard: 2–3 of 30 calls detected at 1.5–3 m.
- Real voices, microphones, Bluetooth and the installed app still need the manual check in the
  report.
