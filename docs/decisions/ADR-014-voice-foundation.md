# ADR-014: Voice Foundation

**Status:** Accepted (2026-09-30)

## Context

ELISE should be conversational: the user speaks, ELISE works (Surfaces assemble in the Live
Workspace) and answers aloud. Voice must not be a second assistant. It is another interface
into the same runtime, tools, permissions, approvals, Recall, Live Workspace and Context
Builder (ADR-012, ADR-013). This milestone is the foundation. Continuous duplex speech, wake
words and background listening come later.

## Decisions

1. **Voice is a modality, not an agent.** A spoken utterance becomes a normal user turn with
   `modality: "voice"` and voice metadata (duration, detected language). It goes through
   `POST /api/chat`, the same chat service, `runElise`, executor and policy as typed text. The
   transcript has no special authority.

   The only difference is in the Context Builder: voice guidance asks for one to three short
   spoken sentences, no markdown, pointers to what's on screen, never "done" before a tool
   result, and never treating a spoken "yes" as an approval.
2. **Where turns live.** A thread is a conversation or a voice session (`ThreadRef`).
   - A new interaction started by voice is an `interaction_session` with `modality='voice'`
     and no conversation, so it has no History thread. Its turns are in `interaction_turns`.
   - Voice used inside an existing conversation stays in that conversation, and those
     messages carry `metadata.modality = "voice"`.
   - Typing during a voice session adds a text turn to the same session.
   - `Thread` (application) hides the difference. `live_workspaces` now belongs to either a
     conversation or a session (enforced by a CHECK and an ownership trigger).
   - `ai_runs` records `interaction_session_id`.
   - Voice sessions reopen on Home with `?session=<id>`.
3. **Recall.** Voice sessions are indexed like conversations: the indexer already reads
   `interaction_turns`. The sweep also covers voice sessions, and queued jobs accept a
   session. Recall results for voice sessions show "Voice interaction" and link to
   `/?session=<id>`.

   Deleting a voice session from History archives it. A trigger deletes its transcripts,
   excerpts and workspace.
4. **Providers.** Behind two core interfaces:
   - `SpeechInputProvider` transcribes one utterance and streams partial text, ending with a
     final transcript and the detected language.
   - `SpeechOutputProvider` synthesizes text to streamed 16-bit PCM and declares its format
     and an allowlist of voices.

   The first implementation is OpenAI, verified against the current API on 2026-09-30:
   - `gpt-transcribe` (`stream=true`): about 1.2–1.5 s for a short Spanish utterance, reports
     the language.
   - `gpt-4o-mini-tts` with `response_format=pcm`: first audio at about 1.3 s, versus about
     2.5 s for MP3.

   Both models are configurable (`OPENAI_TRANSCRIBE_MODEL`, `OPENAI_TTS_MODEL`). No vendor
   SDK or realtime client reaches the core.
5. **Browser audio.**
   - Capture is `getUserMedia`, started only by a tap on the mic or the Orb, with echo
     cancellation and noise suppression.
   - `MediaRecorder` records one utterance at a time. An energy-based end-of-turn detector
     calibrates the noise floor, then ends the turn after 900 ms of silence following at least
     250 ms of speech. Nothing heard for 8 s gives an empty turn, and 60 s is the cap.
   - Playback schedules PCM chunks on Web Audio as they arrive. Both the microphone and the
     player expose their real RMS level, which the Orb reads every frame.
6. **Streaming and speech.** The reply streams as text, as before. A sentence chunker speaks
   each sentence as soon as it completes, so speech starts after the first sentence rather
   than the whole answer.

   The spoken text is the same answer as on screen, minus markdown, links and citations: the
   screen carries the detail and the voice carries the synthesis. Workspace ops keep
   streaming while ELISE speaks.
7. **Lifecycle** (a pure reducer, `core/voice/session.ts`):
   - The phases are idle, listening, muted, transcribing, thinking and speaking. After
     speaking, ELISE listens again, which is how the conversation continues.
   - The microphone is open only while listening.
   - Two empty utterances in a row pause the session to idle.
   - Leaving the page ends the session. Opening an expanded Surface doesn't.
   - `VoiceController` is a framework-free class with injected mic, player and transcriber,
     tested with fakes.
8. **Interruption.** Tapping (the mic or the Orb) while ELISE speaks or thinks stops playback
   at once and starts listening. The text generated so far stays in the thread. A turn sent
   while the previous run is still streaming is queued and sent when that run finishes.

   Automatic barge-in (voice activity detection during playback) is not enabled: without
   reliable echo cancellation, ELISE could hear herself.
9. **Privacy.**
   - The microphone is never opened on page load.
   - The listening state is always visible (the voice bar and mic button, not only the Orb).
   - Stop, Mute and End are always one tap away.
   - Raw audio is only in memory for the upload and is never stored or logged.
   - Transcripts follow normal ownership and deletion.
   - Voice preferences (`voice_enabled`, `voice_output`, `voice_language`, `voice_name`) are
     allowlisted in the database.
10. **Observability.** Per turn, the client measures the time from the mic opening to each of:
    speech end, final transcript, runtime start, first tool, first text, audio start and turn
    complete. It posts only these numbers to `/api/voice/metrics`, which logs them as
    `voice.turn_timing`. Server logs cover transcription latency and bytes. Transcripts and
    audio are never logged.

## Consequences

- Text and voice share one context and one workspace per interaction.
- A voice session isn't in the conversation list. It appears under "Voice interactions" in
  History, where it can be reviewed and deleted.
- Rate limits for voice endpoints are per instance (40 transcriptions and 160 syntheses per
  minute per user). A shared store would be needed at scale.
- **Path to continuous voice:** replace the utterance recorder with a realtime transcription
  stream (`gpt-live-transcribe`) behind `SpeechInputProvider`. Add echo-cancelled voice
  activity detection for automatic barge-in. Optionally add a speech-to-speech provider.
  None of this changes the runtime, threads, workspace or Recall.
