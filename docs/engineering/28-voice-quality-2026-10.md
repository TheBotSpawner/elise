# Voice quality and Desktop parity: investigation and report (2026-10-21, ADR-104)

**Scope:** the owner's report about Desktop voice versus Web voice: cuts, missing speech, beeps,
"Okay", long silences, answers that only point at the screen, and continuous listening. Changes
are in ADR-104. **Nothing here has been measured on a real Windows machine with audio hardware
yet.** Section 6 is the test battery to run.

## 1. The pipeline, as it is

Each stage lists who owns it, its timeout, how it is cancelled, how it is measured, and how Web
and Desktop differ.

1. **Wake.**
   - **Owner:** Desktop `desktop/src/renderer/wake/` (Vosk, local). On the web: Web Speech, only
     for a resting session in continuous mode.
   - **Timeout:** a hand-off of 6 s.
   - **Cancellation:** pause, lock or sleep.
   - **Measured:** traced in development.
   - **Web vs Desktop:** Desktop only. It holds the microphone open (ADR-095).
2. **Capture and VAD.**
   - **Owner:** `VoiceController` + `TurnDetector`.
   - **Timeout:** 2 silences, then sleep.
   - **Cancellation:** `end()`, `sleep()`.
   - **Measured:** `speechEnd`, `turnDetected`.
   - **Web vs Desktop:** same code. On Desktop the window may be hidden.
3. **STT.**
   - **Owner:** `/api/voice/transcribe` → OpenAI `gpt-transcribe`.
   - **Timeout:** 20 s on the server, and a client timeout.
   - **Cancellation:** the capture id.
   - **Measured:** `transcriptFinal`.
   - **Web vs Desktop:** same.
4. **Agent and tools.**
   - **Owner:** `/api/chat` (or GPT-Live delegation).
   - **Timeout:** the stream idle timeout.
   - **Cancellation:** `cancel`.
   - **Measured:** `runtimeStart`, `firstTool`, `toolsDone`, `firstText`.
   - **Web vs Desktop:** the web may run GPT-Live. Desktop runs legacy while the wake word is on.
5. **Progress.**
   - **Owner:** `VoiceController.progress` (ADR-104).
   - **Timing:** 3.5 s of silence; at most 3 lines.
   - **Cancellation:** a result or a failure.
   - **Measured:** `progressTts`, `progressLines`, `maxSilenceMs`.
   - **Web vs Desktop:** same.
6. **TTS.**
   - **Owner:** `/api/voice/speak` → ElevenLabs `eleven_v4_turbo`, with failover to OpenAI.
   - **Timeout:** 15 s on the server; 8 s for a stalled segment.
   - **Cancellation:** abort, plus a generation counter.
   - **Measured:** `firstAudioMs`, `segments`, `maxGapMs`, `speechFailures`.
   - **Web vs Desktop:** the legacy runtime only. The web's GPT-Live speaks through OpenAI
     Realtime.
7. **Playback.**
   - **Owner:** `SpeechPlayer` (Web Audio, 24 kHz s16le mono).
   - **Cancellation:** `stop()`.
   - **Measured:** `audioStart`, `audible`.
   - **Web vs Desktop:** same.
8. **Return to standby.**
   - **Owner:** `complete()` → sleep, then the wake detector resumes.
   - **Measured:** `turnComplete`.
   - **Web vs Desktop:** on Desktop the Orb hides.

## 2. Root causes: what was found, and the evidence

1. **Beeps mid-reply (Desktop).** Probable cause; **not confirmed by ear**.
   - **Evidence:**
     - `elevenlabs/speech.ts` documents that the v4 dialogue model improvises "stray sounds, a
       mechanical beep" on short lines.
     - Only lines of 3 words or fewer avoided that model.
     - Acknowledgement and progress lines are 4–8 words. They went to v4, and their whole audio
       was cached and replayed (`voice-service.ts`), so a beep, once made, repeats.
     - The web often speaks through GPT-Live (OpenAI), which never uses that path. That fits
       "only on Desktop".
   - **Fix:** fixed lines always use the stable model, and the cache version is bumped.
   - **Other sound sources reviewed:**
     - the wake chime (configurable);
     - the error tone, played when offline;
     - the completion tone (habits and tasks);
     - Bluetooth profile switches. Note that Desktop holds the microphone while the wake word
       is on.
2. **Heard but never spoke.** Three causes found, with code evidence, and fixed:
   - a Text-to-Dialogue exchange that ended with no audio resolved to an empty stream: no error,
     so no failover;
   - a single failed segment was skipped, with no retry;
   - a hidden or minimized Desktop window slept the session (`player.stop()`) whenever the wake
     word was off. The GPT-Live session always did.

   Not reproducible here: quota exhaustion. The account hit ElevenLabs `quota_exceeded` on
   2026-10-12. The subscription endpoint didn't answer with this key.
3. **Cuts.**
   - Barge-in was always on. While she spoke, the microphone's energy (room noise, her own voice
     from the speakers) could interrupt her.
   - **Fix:** barge-in only in continuous mode.
4. **10 s or more of silence.**
   - There was one progress line per turn, scheduled 3.5 s after the first tool started. The
     model takes 3–7 s to pick a tool (measured in ADR-034), so silence after the
     acknowledgement could pass 10 s.
   - **Fix:** the progress watch (ADR-104 §4).
5. **"Te lo dejé en pantalla".**
   - The voice guidance itself asked for it: about 40 words at most, an example ending in "Te los
     dejé en pantalla", and "don't read cards aloud".
   - **Fix:** a new response policy, and a spoken cap of 700 characters.
6. **"Okay" and a foreign-sounding voice.**
   - "Okay." was in the Spanish instant acknowledgements, and several lines used the peninsular
     "Déjame".
   - The voices are Voice Design voices labeled `es` (Elise Main DEV, Martín) and `en` (Adriana).
     No accent is declared.
7. **Continuous listening.**
   - `voice_continuous` defaulted to **true** in the database (migration 020). Only onboarding
     turned it off.

## 3. Voice after the change

```
wake (local) → capture one utterance → STT → agent/tools ──► progress watch (3.5 s silence → truthful line, ≤3)
                                                       └──► result speech (cancels pending progress)
→ playback (retry once per segment, failover per segment) → complete → sleep → local wake standby
```

Continuous mode, when the person turns it on, adds listening after the reply and barge-in.
"Dejá de escuchar" ends the session at any point (ADR-102).

## 4. Rioplatense evaluation

| Profile | ElevenLabs voice | Type | Label | Assessment |
|---|---|---|---|---|
| ELISE (default) | "Elise Main DEV" | Voice Design | es | Accent not verified by ear here. A text design doesn't guarantee Rioplatense phonology |
| Martín | "Martín" | Voice Design | es | Same |
| Alternative | "Adriana" | Voice Design | **en** | Will sound foreign in Spanish |

- **Model:** `eleven_v4_turbo` (dialogue) for sentences; `eleven_flash_v2_5` for short lines
  and, now, every fixed line.
- **Native Argentine candidates (Voice Library, read 2026-10-21):**
  - "Sol – Warm Publicity" (female);
  - "Marcelo – Spanish" (male, conversational);
  - "Mauricio", "Franco" and "Juanma" (male; advertising and TV);
  - some are marked for paid plans only.
- **To choose one:**
  1. listen in the ElevenLabs Library;
  2. add it to the account;
  3. put its id in `ELEVENLABS_VOICE_ID_*`;
  4. redeploy.

  No cloning or unlicensed samples were used. Library voices fall under ElevenLabs' terms for
  your plan.

## 5. Benchmarks

**Not measured.** That needs a real Windows machine, a microphone and speakers. No numbers are
claimed. After deploying, every turn logs `voice.turn_timing` with:
- `desktop` (1 or 0);
- `transcriptFinal`, `ackTts`, `progressTts`, `audioStart`, `resultSpeech`;
- `maxSilenceMs`, `audible`, `speechFailures`, `progressLines`, `maxGapMs`.

The metrics the brief asks for come from those fields, for Web and Desktop separately, with p50
and p95 over at least 10 turns per scenario. The stages are computed by `voiceStages()`
(perceived latency, STT finalization, first TTS audio).

**Cost:**
- Continuous off by default removes cloud STT after the answer.
- The wake word is local: zero cloud use while waiting.
- Progress lines are fixed templates: no model tokens, and their audio is cached (one synthesis
  per instance and voice).
- Fixed lines on `eleven_flash_v2_5` cost the same per character as the turbo model on current
  ElevenLabs pricing. This was not re-verified today.

## 6. Windows test battery (manual, owed)

For each item: 10 tries with Desktop **and** 10 on the Web, same account, microphone and network.
Note beeps, cuts, missing speech and the logged numbers.

1. "ELISE, ¿qué hora es?" with Chrome in front: the Orb shows, Chrome keeps focus, the answer is
   heard in full, and she then goes back to waiting (says nothing more, hears nothing more).
2. "ELISE, revisame los correos importantes": an acknowledgement in under about 1.5 s; a progress
   line about 3–4 s after it ends if the search is still running; the answer names senders and
   topics.
3. "ELISE, ¿qué tengo para hoy?", "¿Cuánta plata tengo en Mercado Pago?", "¿Cómo llego a Ramón
   Falcón al 3167?", "Prendé la luz".
4. The same, with the window minimized, in the tray, after lock/unlock and after sleep/wake.
5. Speakers; wired headphones; a Bluetooth headset (expect the call profile while the wake word
   is on).
6. The TV or a conversation in the background during the answer: she must not be cut off.
7. A long answer, then saying nothing: no new turn.
8. Recognition: "Revisame los mails de la facultad", "Poné el aire a veinticuatro", "Dale,
   mostrame el correo de Análisis de Sistemas", "¿Qué hago mañana en Capital?".

## 7. Automated tests run

| Command | Result |
|---|---|
| `format:check`, `lint`, `typecheck`, `typecheck:desktop` | Passed. |
| `test:run` | 187 files and 2429 tests passed (2 skipped). Earlier runs had whole integration files (PGlite) fail under parallel load; they pass alone. |
| `build` (Next) | Passed. |
| `package:desktop` (Electron package, no launch) | Passed. The installer smoke test wasn't run: ELISE was open on this computer, and a second instance hands over to it. |

New tests:
- the progress watch (silence counted from the last audio, a general line before any tool,
  "compose" after the tools, at most 3, nothing after the result);
- an empty dialogue fails;
- fixed lines use the stable model;
- the player retries once;
- OK → Dale;
- the recognition context;
- Spanish lines without "Okay" or "Déjame";
- the `voice_continuous` default, against the real migrations.

## 8. Configuration

- **No new secrets.** Existing: `ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL_ID`
  (`eleven_v4_turbo`), `ELEVENLABS_VOICE_ID_1/2/3/ALT`, `OPENAI_TRANSCRIBE_MODEL`, `SPEECH_PROVIDER`.
- **Migration 061:** `npx supabase db push --linked`.
- **Web:** redeploy.
- **Desktop:** a new build (the renderer ships inside it).
- **Optional:** `ELEVENLABS_VOICE_ID_*` set to a native Argentine voice after listening.
