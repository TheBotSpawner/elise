# ADR-034: Spoken acknowledgements and progress (Voice)

**Status:** Accepted (2026-10-04). Extends ADR-028 (one lifecycle for Voice and Canvas) and
ADR-030 (spoken output). No migration.

## Speech phases

A turn's speech goes through three phases:

| Phase | Category | Example | Can it be dropped? |
| --- | --- | --- | --- |
| ACKNOWLEDGEMENT | `progress` | "Reviso tu agenda." | Yes, it is ephemeral |
| PROGRESS | `progress` | "Sigo revisando tu agenda." | Yes, at most one per turn |
| RESULT | `result` / `conversational` | the verified answer | Never |

Approvals and errors are never dropped either.

Before playback, every ephemeral line is checked again (`stillSayable`) and dropped if:

- the work finished;
- a reply is being said (now including replies that used no tool);
- a new turn began;
- the user barged in;
- it is older than 6 s.

## Classification, with no model call

`ackIntent(tool)` maps a tool to one of these intents:

- `search_web`, `search_knowledge`, `search_recall`
- `check_calendar`, `check_email`, `check_tasks`
- `map_route`, `find_places`
- `analyze_data`, `prepare_meeting`, `plan`
- `create`, `update`, `risky`, `general`

Instant capabilities (the screen, settings, contexts) get no acknowledgement.

Mutations use pre-success wording ("Lo hago.", "Claro, lo agrego."), never "listo". Risky
actions (send, delete, pay…) are only "prepared" ("Sí, lo preparo."), because approval comes
next.

## Early acknowledgement

Real measurements showed that the first tool starts 3.3–7.5 s after the user stops speaking,
while the model decides. So `predictIntent(transcript)` acknowledges plain lookups as soon as
the transcript is final. It runs in the same tick the request is sent: concurrent, never
blocking.

It is deliberately conservative:

- any action verb disables it, so "Mové la reunión" gets a question, never "lo busco";
- utterances under 3 words are skipped;
- chit-chat and direct questions don't match.

If the answer arrives before the acknowledgement plays, the acknowledgement is dropped. Other
turns are still acknowledged when the first tool starts.

## Phrases

- Phrase banks are per intent, in ES and EN, 2–6 words each, calm and specific.
- "un segundo" appears once in total.
- `pickAcknowledgement(intent, locale, recent)` chooses the first line not said in the
  session's last 6, else the least recent one. Deterministic, so tests aren't flaky.

## Progress

- One line, `PROGRESS_AFTER_MS` (3.5 s) after the acknowledgement.
- Only while tools are still running, nothing failed, and no result is queued.
- It names the work, never a tool.

## Audio

Acknowledgement and progress lines go through the same `SpeechPlayer`, speech-turn identity,
barge-in and stale checks as everything else.

- **Legacy runtime:** the deployment's provider and the user's voice (ElevenLabs here).
- **Warm-up:** when voice starts, `POST /api/voice/speak/warm` synthesizes the lines this server
  instance doesn't hold yet. The cache is keyed by provider, voice and phrase, so an ElevenLabs
  voice never plays OpenAI audio.
- **Measured:** acknowledgement audio starts 0.2–0.5 s after it is queued.

## GPT-Live (the default runtime)

The voice model speaks its own acknowledgement. Its instructions now make that explicit:

- one short line that fits the work, varied across turns;
- "Lo hago." for actions, and never "listo" before ELISE confirms;
- none for instant actions or clarifications.

ELISE adds one spoken progress line, through `session.commentary.append`, after the same
threshold, and only while the delegation is still running.

## Telemetry

Timing marks: `ackReady`, `ackTts`, `progressTts`, `firstTool`, `toolsDone`, `resultSpeech`,
`audioStart`.

Trace events (`elise.voiceDebug`):

- `ack_predicted`, `ack_skipped`, `ack_tts_started`, `ack_dropped_stale`;
- `progress_emitted`, `progress_skipped`, `progress_dropped`.

No speech content is logged.
