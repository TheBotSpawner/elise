# ADR-030: Spoken output — speech segmenter, continuous playback, ElevenLabs provider

**Status:** Accepted (2026-10-03). Extends ADR-014 (voice), ADR-026 (GPT-Live) and ADR-028
(speech lifecycle). Migration `20261007000026_voice_profiles.sql`.

## Why ELISE sounded cut and read-like (root causes, measured in code)

1. **Serial synthesis.** The player requested sentence N+1 only after sentence N's download had
   finished. Whenever the next request's time to first byte (about 0.5–1.5 s) was longer than the
   audio still buffered, playback ran dry. That was the audible gap between sentences.
2. **No context between sentences.** Each sentence was synthesized on its own, so every one
   restarted its intonation and ended with a falling cadence. That was the "read" effect.
3. **Tiny units.** The chunker emitted sentences from 12 characters and also split on `:` and
   `;`.
4. **Mid-word cuts.** Over-long text could be cut at a fixed index (`maxSpokenChars`), which
   can split a word or a number.

A new voice alone would fix none of these.

## Decision

1. **Speech segmenter** (`SentenceChunker`, `core/voice/speech-text.ts`):
   - the first unit goes out at the first sentence end of at least 24 characters (fast start);
   - later units gather whole sentences up to about 90 characters (continuous prosody);
   - a sentence over 200 characters is cut at its last clause, never inside a word, a number, a
     time or after an abbreviation;
   - `:` and `;` don't end a unit.

   Units never go out token by token.
2. **Continuous playback** (`SpeechPlayer`):
   - the next unit is requested while the current one plays, and scheduled back-to-back;
   - each request carries the previous unit (`previous` → `previousText`), so providers that
     support it (ElevenLabs `previous_text`) continue the same intonation;
   - each segment reports its size, the silence before it and its time to first audio
     (`segments`, `avgSegmentChars`, `maxGapMs`, `firstAudioMs`), recorded in voice metrics and
     shown in the development `[voice] timeline`.
3. **Speech formatter** (`core/voice/speech-format.ts`, server-side, every provider). It applies
   `toSpeakable` (Markdown, links and citations out), then deterministic spoken forms:
   - amounts: "$23.500" → "veintitrés mil quinientos"; "US$ 1.200" → "mil doscientos dólares";
   - Spanish times: "14:30" → "las dos y media de la tarde";
   - grouped integers become words, and percentages become "por ciento".

   Unrecognised text is left exactly as written. Provider control syntax written by the model
   (`[laughs]`, `<break/>`) is stripped, so nothing injects effects.
4. **Provider abstraction.** It is unchanged: `SpeechOutputProvider`, behind
   `/api/voice/speak`. `VoiceController` doesn't know which provider speaks.
   - `SPEECH_PROVIDER=openai|elevenlabs` (default `openai`), reversible with one variable.
   - ElevenLabs: `ELEVENLABS_API_KEY` (server-only), `ELEVENLABS_VOICE_ID[_ALT]`, and
     `ELEVENLABS_MODEL_ID` (default `eleven_v4_turbo`).
5. **ElevenLabs adapter** (`infrastructure/ai/elevenlabs/speech.ts`), checked against the docs on
   2026-10-02:
   - `eleven_v4_turbo` (and other v3/v4 models) stream only through the **Text to Dialogue
     WebSocket**. The adapter sends `{voices, xi_api_key, voice_settings}` → `{inputs}` →
     `{flush}`, reads base64 audio until `is_final`, and outputs `pcm_24000`.
   - Other models (`eleven_flash_v2_5`…) use HTTP streaming with `previous_text`.
   - **Where it runs:** on the server, one socket per segment. The permanent key stays on the
     server, the setup works on serverless hosting, and barge-in, stale-progress and the speech
     queue stay single (ADR-028).
   - **Not chosen:** a persistent browser socket per Voice session would need a single-use
     frontend token for this endpoint. The documented token types are `realtime_scribe` and
     `tts_websocket`; support on Text to Dialogue isn't verified yet.
6. **Failover** (`FailoverSpeechOutput`):
   - If ElevenLabs fails before any audio, that segment is spoken by the current provider (its
     default voice), and ElevenLabs rests for 60 s (a circuit breaker).
   - A mid-segment failure ends that segment; nothing is replayed.
   - A cancellation (barge-in) is never treated as a failure.
7. **Voice profiles** (`core/voice/profiles.ts`): `ELISE` and `ELISE · alternativa` map on the
   server to the configured ElevenLabs voice ids; the current provider's voices stay as profiles.
   - Profiles hold no secrets, model names or provider ids.
   - A stored voice that belongs to the inactive provider resolves to the active provider's
     default.
   - A later ELISE-designed voice or consented clone is a new profile id → voice mapping.
8. **Settings › Voice:** a provider status line, the curated voice select, and **Preview**, a
   fixed universal sample from `/api/voice/preview`, never the user's own content.
9. **Character settings** in one place (`ELISE_VOICE_SETTINGS`: stability 0.55, similarity 0.75,
   style 0, speed 1). Calm and consistent, not theatrical. They are to be retuned with real A/B
   listening.

## Not done / pending

- **Real ElevenLabs validation.** No key was available in this environment. The latency,
  naturalness, Spanish quality, cost and fast-model comparison all need `ELEVENLABS_API_KEY` and
  a voice id. The adapter, its protocol and failover are covered with mocked HTTP and WebSocket.
- **Delivery intents and audio tags.** The v4 Turbo tag vocabulary isn't in the WebSocket
  reference. Model-written tags are stripped. A typed whitelist (warm, caution…) comes after
  listening tests.
- **One socket per Voice session** needs browser single-use tokens on Text to Dialogue, or a
  stateful voice server.
- **Migration** `20261007000026_voice_profiles.sql` must be applied before users can save the
  `elise` profiles.

## Consequences

- Fewer, longer segments are requested ahead of time, so silences between them disappear,
  whichever provider speaks.
- ElevenLabs can be switched on and off with configuration, and Voice Mode survives its outages.
- ElevenLabs bills per character. Usage is recorded per segment
  (`usage_events`: operation `speech`, provider `elevenlabs`, characters, latency).
