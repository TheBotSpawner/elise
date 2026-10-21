# ADR-104: Voice that is heard, says what matters, and sounds Rioplatense

**Status:** Accepted (2026-10-21). Refines ADR-014/017 (voice), ADR-030 (ElevenLabs), ADR-034
(acknowledgements), ADR-036, ADR-068 (voice preferences) and ADR-095/096 (Desktop).

## Context

Reported from real use, mostly on ELISE Desktop:
- the voice cuts out;
- it sometimes hears but never speaks;
- it beeps mid-reply;
- it says the English "Okay";
- it is silent for 10 s or more during tools;
- spoken answers are just "te lo dejé en pantalla";
- the conversation keeps listening after the answer.

The full investigation is in `docs/engineering/28-voice-quality-2026-10.md`.

## Decision

1. **One turn at a time by default.**
   - `user_profiles.voice_continuous` now defaults to off (migration 061, additive). Stored values,
     an explicit "on" included, are kept.
   - Barge-in follows continuous conversation (`voicePreferences`). Off, the microphone closes once
     the request is understood: room noise, a TV or ELISE's own voice never cut her answer. A tap
     on the microphone or the Orb stops her.
   - After the answer, the session sleeps, and Desktop goes back to local wake standby.
2. **No silent spoken turns.**
   - **Empty dialogue.** An ElevenLabs Text-to-Dialogue exchange that ends with no audio is now a
     failure, so the OpenAI failover speaks instead of returning an empty stream.
   - **Player retry.** A segment that fails before any of its audio is scheduled is requested
     once more, keeping order; a second failure is reported and skipped.
   - **Hidden window.** On Desktop, a hidden or minimized window never sleeps a reply in
     progress, with or without the wake word on, in both the legacy and the GPT-Live runtimes.
3. **Fixed lines never use the improvising model.**
   - Acknowledgements and progress lines are cached and replayed, so they always use the stable
     HTTP model (`fixedLine`), never the v4 dialogue model.
   - The dialogue model is documented to improvise sounds ("a mechanical beep") on short lines,
     and the cache would replay any such sound every time.
   - The acknowledgement cache version is bumped to 3, so audio cached before this change is
     never served again.
4. **Progress watch.**
   - From the moment the request goes out, a turn that has been silent for 3.5 s (counted from
     the end of the last audio) gets a truthful line.
   - The line names the running tool's kind, or says "Ya tengo los datos, estoy armando la
     respuesta." once every tool has finished.
   - At most 3 lines per turn, never repeated, never after the result is queued or after a
     failure. A line not yet playing when the result arrives is dropped.
   - The lines are fixed templates: no extra model call.
5. **The spoken answer stands on its own.**
   - The voice guidance (legacy and GPT-Live delegation) sets the length by kind of answer:
     - a command: one sentence after confirmation;
     - several items: the count, then up to four items with what identifies each (an email's
       sender and topic, an event's time and title), then the most urgent one if the results
       show it; about 40–90 words;
     - a plan: its blocks with their times.
   - Never only "te lo dejé en pantalla", and never invented senders, topics or urgency.
   - The spoken cap goes from 420 to 700 characters.
6. **Rioplatense.**
   - Spanish fixed lines are voseo, and "Okay." / "Déjame" are gone.
   - In Spanish, an "OK" that opens a sentence is spoken as "Dale". Only the TTS text changes;
     the screen keeps what was written.
   - **Recognition.**
     - The recognition prompt carries a Rioplatense hint, but only for users whose timezone is in
       Argentina. Other Spanish speakers get "Español."; English speakers get no variant hint.
     - It also carries up to 30 of the user's own names (Knowledge Spaces, Finance accounts),
       cached for 10 min, read under RLS, at most 800 characters.
     - `language` stays ISO "es". OpenAI's prompt costs nothing extra.
7. **Diagnostics.** Per-turn marks gain:
   - `progressLines`;
   - `audible` (1 or 0);
   - `speechFailures`;
   - `maxSilenceMs`, the longest silence before audio;
   - `desktop` (1 or 0).

   They are logged as `voice.turn_timing`, numbers only, so Web and Desktop compare side by side.

## Consequences

- **Interrupting her.** In single-turn mode she can't be interrupted by speaking; a tap or the
  Orb does it. A spoken "basta" works in continuous mode (ADR-102).
- **Accent.** The voices are ElevenLabs Voice Design voices labeled `es`, and one (`Adriana`) is
  labeled `en`. A text prompt can't make them sound Argentine. Native Rioplatense voices exist
  in the Voice Library. Choosing one needs listening and the owner's decision.
- **Bluetooth on Desktop.** While the wake word is on, Desktop holds the microphone (ADR-095), so
  Windows keeps a Bluetooth headset in its "call" profile: lower quality than the web, which
  releases the microphone.
- **Validation owed.** Beeps, cuts and latency are still to be measured on a real Windows machine
  with the test battery in the report.

## Addendum (2026-10-21, afternoon): the dialogue model only for whispers

With fixed lines already on the stable model and the server deployed, the owner still heard
beeps in the middle of ordinary replies ("el índice de referencia del Merval…").

Measured that afternoon:
- The same reply sentences synthesized through the OpenAI fallback (`gpt-4o-mini-tts`, voice
  `marin`) contain no tone and no click. The check uses a pure-tone detector (one dominant
  frequency above 600 Hz, held at least 65 ms, voice harmonics excluded), and a beep injected
  for testing was detected.
- ElevenLabs couldn't be re-recorded: the API key "Elise API Key DEV" hit its own cap of
  10,000 credits (`quota_exceeded`). Until it is raised, every line is spoken by the failover.

**Decision:** the ElevenLabs dialogue model (`eleven_v3`/`eleven_v4_*`) now synthesizes only a
quiet or whispered delivery, which the stable model can't do. Every other sentence uses
`eleven_flash_v2_5` over HTTP, with `previous_text` for continuity. That is the same voice, with
lower latency and no improvisation.

**Still open:** the ElevenLabs path can't be measured until the key has credits.
