# ADR-026: Voice 2.0 — GPT-Live frontend over a transport-independent turn engine

**Status:** Accepted (2026-10-02). Supersedes the voice transport parts of ADR-014 and ADR-017;
the legacy pipeline stays as a fallback. Docs verified 2026-10-02:
[GPT-Live](https://developers.openai.com/api/docs/guides/live),
[delegation](https://developers.openai.com/api/docs/guides/live-delegation),
[sessions](https://developers.openai.com/api/docs/guides/live-conversations).

## Context

The legacy voice pipeline runs microphone → VAD (1.1 s silence) → STT → ELISE → TTS. It measured
6.4 s p50 / 12.9 s p90 from speech end to first audio, its barge-in was a browser heuristic, and
its turn logic was tied to the HTTP chat stream.

GPT-Live (`gpt-live-1`) connects over WebRTC and handles turn-taking, interruptions and speech
natively. With **client delegation** it hands requests to the application. Two facts shaped the
design:

- The delegation event carries an id but **no request text**: the app rebuilds the request from
  the live transcripts.
- Results go back as `session.commentary.append` (spoken) or `session.thinking.append` (silent),
  at most 500 tokens each.

## Decision

1. **Transport-independent turn engine** (`prepareTurn` in `application/chat-service.ts`).
   - Setup happens first and can fail as a request error.
   - Then `run(emit, { signal })` emits the typed turn events: conversation, status, text,
     spoken, tool started/finished, workspace ops, done, error.
   - It has no dependency on HTTP, `ReadableStream`, browser or voice objects.
   - Adapters:
     - **HTTP chat** (`startChatTurn`): NDJSON, unchanged behaviour for typed and legacy voice
       turns.
     - **GPT-Live delegation** (`runDelegation`, `POST /api/voice/live/delegate`): the same events
       plus a compact `delegation` result.
2. **GPT-Live is the voice frontend; ELISE stays the backend.**
   - The browser talks to GPT-Live over WebRTC; audio never passes through ELISE.
   - `POST /api/voice/live/session` (authenticated, voice enabled, rate-limited) exchanges the SDP
     with `POST /v1/live/sessions` using the server key. The browser never receives a key.
   - The session gets a hashed safety identifier (`OpenAI-Safety-Identifier`).
   - The data channel only accepts the client events ELISE needs: results, progress, mute, close.
3. **Delegation.**
   - GPT-Live decides to delegate from its prompt's delegation policy. The browser then:
     1. waits about 450 ms for the transcript to settle;
     2. takes what the user said since ELISE last spoke (corrections included);
     3. runs it through the same chat path as typed turns (`useEliseChat`, `live` option).
   - The Canvas, traces, approvals and History therefore behave exactly as in text.
   - Progress: the first tool of each group sends silent verified progress ("checking the
     calendar").
   - The result is a compact `DelegationResult`: status, spoken summary, key on-screen facts,
     pending approval. Large detail stays on the Canvas.
   - **Safety rules:**
     - Each delegation id runs once (`ai_runs.request_id = live:<id>`).
     - A result that arrives after a newer request is sent as silent context, never announced.
     - "Dejalo / never mind" aborts the work in flight and never runs a model.
     - A correction within 4 s of the previous request replaces it, with both texts kept.
     - Anything later queues behind the running work: long tasks are never killed by small talk.
4. **Prompts.** The GPT-Live prompt (`core/voice/live.ts`) holds identity, voice style,
   interruptions, restrained backchannels, the delegation policy and "never guess backend
   results". The backend keeps every tool and business rule. Live delegations get a short
   `LIVE_DELEGATION_GUIDANCE`: transcripts have false starts; reply with `<spoken>` result + display
   detail; approvals as questions.
5. **Approvals stay deterministic.** A spoken "sí" is delegated like anything else, and only the
   existing `bindVoiceApproval` resolves it:
   - exactly one pending approval of the same interaction, within 5 minutes;
   - "sí, borrala" (yes plus the action verb) now counts as approval;
   - an unrelated question leaves it pending.
6. **Persistence.**
   - Delegated exchanges are persisted by the engine.
   - Conversation-only exchanges (greetings, "repeat that") are persisted from the transcript
     timeline (`POST /api/voice/live/turns`), and only once settled.
   - Everything goes into the same `interaction_sessions` / `interaction_turns`, so History and
     Universal Recall cover Live voice like before. No new history system.
7. **Lifecycle.**
   - One WebRTC session per Voice Mode.
   - It sleeps after 2 minutes without speech, because GPT-Live bills every second it's open.
   - Hidden tab → sleep.
   - A lost connection reconnects with a new session; delegated work keeps running over HTTP.
8. **Runtime flag.** `VOICE_RUNTIME=legacy|live` (default `legacy`); `?voice=live|legacy` compares
   both on Home. The legacy pipeline stays as the fallback.
9. **Provider resilience.** Model calls with no output for 8 s (fast and standard profiles) are
   retried once; ~1% of fast calls stalled 19–30 s with zero reasoning tokens. Billing errors read
   "no credits", not "provider down".

## Measurements (real Chrome, real GPT-Live, WAV file as microphone)

| | Legacy (performance milestone) | GPT-Live |
|---|---|---|
| Speech end → first audio | 6.4 s p50 / 12.9 s p90 (production-equivalent) | **2.0 s / 2.5 s** (14-turn dev run); 2.8 s / 7.8 s (production run) |
| Conversation-only reply | same pipeline | **≈1.0–1.5 s** |
| Barge-in → ELISE silent | heuristic | **≈0.5 s** (barge-in sample, production run) |
| Speech end → verified delegated answer | (= first audio) | 6.3 s / 10.8 s (production run); 8.7 s / 17.5 s (dev run) |
| Session setup | — | 1.4–2.8 s, once per Voice Mode |

Cost per 1,000 voice turns (estimates):

- **Live:** about **$19–24**, dominated by session time (20–26 billed seconds per turn, silence
  included) plus ~$2 of backend models.
- **Legacy:** about **$3** (backend models, STT and TTS).

## Consequences

- Voice now feels conversational: fast acknowledgements, local small talk, natural interruption,
  and a continuous session.
- Delegated answers are not faster than legacy yet: the backend dominates, with two Luna calls
  plus tools at about 5–6 s.
- Live costs roughly 7–8× more per turn.
- Live stays opt-in (`VOICE_RUNTIME=live`) until:
  - the legacy-vs-Live browser benchmark completes (it was cut short by an OpenAI credit outage);
  - mobile is validated on devices;
  - the cost is accepted.
- **Removal path for legacy:** after Live is the default for one release with no fallback use,
  delete `voice-controller`, `microphone`, `speech-player`, `wake-engine` and the
  transcribe/speak routes.
- **Desktop Companion:** reuse the same pieces — the session endpoint, `TranscriptTimeline`,
  delegation through `/api/voice/live/delegate`, and the result format. It needs its own WebRTC
  client and wake word, and must not depend on the browser tab staying visible.
