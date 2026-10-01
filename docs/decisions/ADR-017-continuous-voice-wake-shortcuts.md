# ADR-017: Continuous Voice, Wake Phrase and ELISE Shortcuts

**Status:** Accepted (2026-10-01)

## Context

ADR-014 made voice a modality of the one ELISE. After each spoken reply ELISE listened
again, but a turn ended on a fixed 900 ms pause, interrupting ELISE meant tapping, the
microphone stayed open while the page was open, and every request went through full model
planning. This milestone makes the conversation continuous and adds two separate concepts:
a **wake phrase**, which wakes a sleeping voice session, and **Shortcuts**, which are
user-defined triggers for existing workflows. All three stay on the same runtime, tools,
policies, approvals, Live Workspace, Recall and Context Profiles. Web first: nothing here
pretends to be an OS-level assistant.

Provider and browser APIs checked on 2026-10-01:
- **OpenAI Realtime voice activity detection.** `server_vad` and `semantic_vad` (eagerness
  low/medium/high) exist for conversation sessions. `gpt-live-transcribe` transcription
  sessions require `turn_detection: null`, so the application commits each turn itself.
- **Chrome on-device Web Speech** (Chrome 139+): `SpeechRecognition.available({langs,
  processLocally})` → available / downloadable / downloading / unavailable,
  `SpeechRecognition.install(...)`, the instance properties `processLocally` and `phrases`
  (contextual biasing).
- **Wake-word engines.** Picovoice Porcupine Web licenses custom keywords for personal and
  non-commercial use only. openWakeWord has no "Elise" model and needs a training pipeline.
  Vosk-browser needs a model download of about 40 MB.

## Decisions

### Voice session

1. **One canonical state machine** (`core/voice/session.ts`), pure and shared by the
   controller, the UI and the tests. The phases are idle, arming, listening, user_speaking,
   finalizing_input, thinking, executing, speaking, interrupted, waiting_approval, muted,
   sleeping, offline and error. `micOpen()` and `wakeListening()` are derived from the phase;
   no component keeps its own flags.
2. **Turn detection runs in the browser, using energy plus the transcript.** The application
   has to end turns itself either way: the realtime transcription model that streams text
   doesn't detect turns in transcription sessions.
   - Energy: the noise floor is calibrated, a voiced threshold is set from it, and speech
     must last at least a minimum time.
   - Transcript: after a short pause (600 ms), the recording so far is transcribed
     **speculatively**, without stopping the recorder.
   - The turn ends after 1.1 s of silence when that transcript looks finished. When it looks
     unfinished (it ends in a conjunction, preposition, article, comma or filler, in Spanish or
     English), the silence needed grows to 2.4 s.
   - If the user speaks again, the speculative result is thrown away. When the turn ends with
     no new audio since the snapshot, the speculative transcript is the final one, so there is
     no transcription wait.
   - Every threshold lives in `VOICE_TURN`.
   - Realtime streaming transcription (`gpt-live-transcribe` over WebRTC) remains a drop-in
     replacement behind `SpeechInputProvider`.
3. **Barge-in.**
   - While ELISE speaks, the microphone stays open (echo cancellation, noise suppression and
     auto gain on) and a pure `BargeInDetector` compares the input level with ELISE's own
     output level.
   - It first estimates how much of the speaker leaks into the microphone. User speech must
     clearly exceed that predicted echo for 280 ms.
   - On barge-in, playback stops within one audio frame, the recording made while ELISE spoke
     becomes the user's utterance, and the same session continues.
   - A transcript that mostly repeats what ELISE just said is dropped as self-echo.
   - The always-visible stop control remains, and barge-in can be switched off in Settings
     (`voice_barge_in`) for rooms where it misfires.
4. **Speaking stays truthful and short.** The reply is spoken sentence by sentence as it
   streams, up to the existing spoken limit, with the rest left on screen. ELISE never says an
   action happened before its tool result. When a tool takes noticeable time, the voice
   guidance allows one short acknowledgement ("Dejame revisar tus mails"), not canned filler.
5. **Sleep.**
   - After 30 s of listening with no speech (`VOICE_TURN.sleepAfterMs`), the session sleeps:
     the microphone is closed, the Orb rests (idle) and the voice bar shows "asleep".
   - If the page is hidden, the session sleeps at once and says so when the page returns.
     ELISE never claims to have listened while the browser suspended it.
   - Tapping, or the wake phrase where available, wakes it.
   - Ending a session releases the microphone immediately.
6. **Offline.** Losing the network (an `offline` event, or failed voice requests) moves the
   session to `offline`: the microphone is closed and "reconnecting" is shown. Coming back
   online returns to sleeping, never to listening without the user.

### Wake phrase

7. **Chrome on-device Web Speech, only when it's really on the device.**
   - The wake engine starts a continuous `SpeechRecognition` with `processLocally = true`,
     biased with `phrases`, and only while the session is sleeping and the page is visible.
   - Before anything runs, the engine checks `SpeechRecognition.available({langs,
     processLocally:true})`.
     - "available": the wake phrase can be enabled.
     - "downloadable": the user can install the language pack from Settings.
     - Anything else, or an older browser: wake is marked unavailable and voice works as
       before.
   - Audio is never sent anywhere for wake detection. Interim results are matched in memory
     and dropped, and nothing before the wake phrase is kept.
8. **Matching is strict.** The wake phrase must start the recognized utterance (allowing a
   leading "ok"/"hey"/"oye") or be all of it. Recognizer confidence below 0.5, when the
   recognizer reports one, is ignored. Whatever follows the wake phrase in the same utterance
   ("Elise, Morning Brief") becomes the first turn.
   - **Phrases:** an allowlist of "Elise", "Hey Elise", "Oye Elise", "Liz". Free-form custom
     phrases are not offered because recognition quality for arbitrary words can't be promised.
   - **Sensitivity:** the engine exposes no sensitivity parameter, so the UI shows none.
   - ELISE's own speech can't wake her: the engine doesn't run while she speaks.
9. **Self-Control.** `voice.setWakePhrase` changes the phrase among the allowlist and can
   turn the wake phrase on or off. If the browser can't detect it, the reply says so instead
   of claiming success.

### Shortcuts

10. **A Shortcut is a typed trigger for existing workflows.** The `shortcuts` table holds a
    name, trigger phrases, an enabled flag, an optional context profile, a confirmation flag,
    and 1–4 typed steps.
    - **Steps come from an allowlisted registry** (`core/shortcuts/registry.ts`). Each step
      type has a zod schema for its parameters and maps to existing tools:
      - `morning_brief.run` → `briefs.today`
      - `daily_planning.start` → `planning.today`
      - `meeting.prepare_next` → `meeting.prepare`
      - `study.start`, `work.brief`, `context.activate`
      - `tasks.show_today` → `tasks.list`
      - `calendar.show_today` → `calendar.listEvents`
      - `finance.show_summary` → `finance.getSummary`
      - `workspace.clear` → `ui.clear`
      - `appearance.set_theme`
    - There is no code, no URL, no free prompt and no unrestricted JSON.
    - Triggers are not voice-only: the same Shortcut runs from My Elise and from chat
      (`shortcuts.run`).
11. **Matching** (`core/shortcuts/match.ts`) is deterministic and conservative.
    - The utterance is normalized: accents, punctuation, a leading wake phrase and politeness
      words are removed.
    - It runs automatically only on an exact match, or a near-exact one (one small typo in a
      phrase of 8 or more characters).
    - Anything longer or different falls through to normal reasoning. "¿A qué hora arrancamos
      mañana?" never runs "arrancamos". A question mark disqualifies a match.
    - Two enabled shortcuts can't share a phrase; this is checked on save.
12. **Execution reuses the runtime; it doesn't bypass it.**
    - A matched Shortcut skips model planning. Its steps run through `executeToolCall` with
      origin `ai`, so policy, approvals, permissions and RLS apply exactly as if ELISE had
      decided on her own. A Shortcut never grants authority.
    - Their results go to the model as tool results, and one model turn writes the short
      synthesis (spoken in voice).
    - Provenance is recorded: the assistant message metadata records the Shortcut, and an
      audit event records `shortcut.run`.
13. **Creating from chat.** `shortcuts.propose` maps a request to allowlisted steps and shows a
    Shortcut Surface with Save; nothing is saved until the user confirms. `create`, `update`,
    `enable` and `disable` are audited writes. `delete` is destructive and asks when ELISE
    proposes it. Nothing is created by default.

### Daily planning and the Morning Brief

14. **`planning.today`** is an orchestration on the Live Workspace: today's calendar, open
    tasks due today or overdue, habits due today, active goals and the contexts in focus,
    gathered through the executor. The model then suggests an order. It is not a planner
    application.
15. **`briefs.today`** runs the same Morning Brief gathering and assembly the scheduled brief
    uses, now, in the workspace. Retrieval isn't duplicated. The Morning Brief answers "what
    should I know"; Daily Planning answers "what will I do and in what order".

### Voice approvals

16. **A spoken "sí" may approve, under strict binding** (`core/voice/approval.ts`). The
    turn's modality must be voice, the phrase must be a clear approval ("sí", "aprobalo",
    "confirmo", "dale, envialo") or rejection ("no", "cancelalo", "dejalo"), and all of the
    following must hold:
    - exactly one pending approval;
    - requested by this interaction's previous assistant turn;
    - created within the last 5 minutes;
    - same user and workspace.

    Two or more approvals means ELISE asks which. A "sí" with no approval is just
    conversation. Resolution uses the same `resolveApproval` as the Approve button, and the
    audit records `channel: "voice"`.

### Platform boundary

17. **`DeviceRuntime`** (`core/voice/device.ts`) is the boundary for what a future desktop
    companion would provide: wake phrase, microphone, notifications, global hotkey. The web
    implementation fills in what browsers allow. There are no fake desktop endpoints.
18. **Latency** marks per turn: wake, listening, speech start and end, turn detected,
    transcript final, runtime start, first tool, first Surface, first text, first audio,
    barge-in, audio stopped. They are posted as numbers only and also kept in
    `window.__eliseVoiceTimings` in development.

## Consequences

- Voice still has no runtime of its own: shortcuts, approvals and the wake phrase only decide
  what reaches the same chat turn.
- Speculative transcription can cost one extra transcription call per turn when the user
  pauses and resumes. The gain is no transcription wait at the end and fewer cut-off turns.
- The wake phrase works only in Chromium browsers with on-device speech for the language, on a
  visible tab with the session asleep. Closed browsers, locked screens, background tabs and
  mobile background states can't hear it. That is the desktop companion's job.
- Barge-in quality depends on the browser's echo cancellation. Headphones are reliable;
  laptop speakers usually are. The explicit stop control stays.
