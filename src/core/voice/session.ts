/**
 * The voice session (ADR-014, ADR-017): one canonical, pure state machine shared by the
 * controller, the UI and the tests. Every component derives what it shows — and whether the
 * microphone may be open — from the phase; nothing keeps flags of its own.
 *
 *   idle ─start→ arming ─mic ready→ listening ─speech→ user_speaking ─pause→ finalizing_input
 *                                      ↑                                         │ transcript
 *                    reply done ───────┤                                         ↓
 *        speaking ←─ first audio ── thinking ⇄ executing (a tool runs)        thinking
 *           │ user speaks (barge-in) → interrupted → user_speaking
 *   listening ─30 s silence / page hidden→ sleeping ─wake phrase / tap→ arming
 *   any active ─network lost→ offline ─back online→ sleeping
 *   reply done with an approval pending → waiting_approval (listening for "sí" / "no")
 */

export type VoicePhase =
  | "idle"
  | "arming"
  | "listening"
  | "user_speaking"
  | "finalizing_input"
  | "thinking"
  | "executing"
  | "speaking"
  | "interrupted"
  | "waiting_approval"
  | "muted"
  | "sleeping"
  | "offline"
  | "error";

export type VoiceProblem =
  | "permission_denied"
  | "no_microphone"
  | "not_supported"
  | "transcription_failed"
  | "nothing_heard"
  | "speech_failed"
  | "network";

/** Why the session is asleep (shown honestly when it wakes). */
export type SleepReason = "inactivity" | "hidden" | "offline";

/** The wake phrase engine, as far as this browser allows (ADR-017 §7). */
export type WakeStatus =
  "off" | "unsupported" | "downloadable" | "installing" | "ready" | "listening" | "failed";

export interface VoiceState {
  phase: VoicePhase;
  /** The transcript as it is recognized (shown subtly while finalizing). */
  partial: string;
  problem: VoiceProblem | null;
  /** Speaking back is on (the user may keep voice input with text-only replies). */
  speak: boolean;
  /** Speaking over ELISE interrupts her (the mic stays open while she speaks). */
  bargeIn: boolean;
  /** After a reply, listen again (off: the session sleeps after each turn). */
  continuous: boolean;
  /** Utterances in a row with nothing recognized: after two, the session sleeps. */
  misses: number;
  sleep: SleepReason | null;
  wake: WakeStatus;
}

export type VoiceEvent =
  | { type: "start"; speak: boolean; bargeIn: boolean; continuous: boolean }
  | { type: "mic_ready" }
  | { type: "mic_failed"; problem: "permission_denied" | "no_microphone" | "not_supported" }
  | { type: "speech_start" }
  | { type: "speech_end" }
  | { type: "partial"; text: string }
  | { type: "transcript"; text: string }
  | { type: "transcription_failed" }
  | { type: "tool_started" }
  | { type: "tool_finished" }
  | { type: "speaking" }
  | { type: "speech_failed" }
  | { type: "reply_done"; awaitingApproval: boolean }
  | { type: "barge_in" }
  | { type: "interrupt" }
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "sleep"; reason: SleepReason }
  | { type: "wake" }
  | { type: "offline" }
  | { type: "online" }
  | { type: "wake_status"; status: WakeStatus }
  | { type: "end" };

export const initialVoice: VoiceState = {
  phase: "idle",
  partial: "",
  problem: null,
  speak: true,
  bargeIn: true,
  continuous: true,
  misses: 0,
  sleep: null,
  wake: "off",
};

const MAX_MISSES = 2;

/** Phases in which the user may be talking to ELISE (the recorder runs). */
const HEARING: ReadonlySet<VoicePhase> = new Set([
  "listening",
  "user_speaking",
  "waiting_approval",
  "interrupted",
]);
/** ELISE is working on a reply. */
const REPLYING: ReadonlySet<VoicePhase> = new Set(["thinking", "executing", "speaking"]);
/** A session exists (the mic may be closed, e.g. asleep). */
const ACTIVE: ReadonlySet<VoicePhase> = new Set([
  "arming",
  "listening",
  "user_speaking",
  "finalizing_input",
  "thinking",
  "executing",
  "speaking",
  "interrupted",
  "waiting_approval",
  "muted",
]);

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  const to = (phase: VoicePhase, patch: Partial<VoiceState> = {}): VoiceState => ({
    ...state,
    phase,
    ...patch,
  });
  switch (event.type) {
    case "start":
      return state.phase === "idle" || state.phase === "error" || state.phase === "sleeping"
        ? {
            ...initialVoice,
            phase: "arming",
            speak: event.speak,
            bargeIn: event.bargeIn,
            continuous: event.continuous,
            wake: state.wake === "listening" ? "ready" : state.wake,
          }
        : state;
    case "mic_ready":
      return state.phase === "arming" ? to("listening", { problem: null }) : state;
    case "mic_failed":
      return to("error", { problem: event.problem, partial: "" });
    case "speech_start":
      return state.phase === "listening" ||
        state.phase === "waiting_approval" ||
        state.phase === "interrupted"
        ? to("user_speaking", { problem: null })
        : state;
    case "speech_end":
      return HEARING.has(state.phase) ? to("finalizing_input", { partial: "" }) : state;
    case "partial":
      return state.phase === "finalizing_input" || state.phase === "user_speaking"
        ? { ...state, partial: event.text }
        : state;
    case "transcript": {
      if (state.phase !== "finalizing_input") return state;
      if (!event.text.trim()) {
        // Never invent what the user said: nothing heard means listen again (then sleep).
        const misses = state.misses + 1;
        return misses >= MAX_MISSES
          ? to("sleeping", { partial: "", problem: "nothing_heard", misses, sleep: "inactivity" })
          : to("listening", { partial: "", problem: "nothing_heard", misses });
      }
      return to("thinking", { partial: event.text, problem: null, misses: 0 });
    }
    case "transcription_failed":
      return state.phase === "finalizing_input"
        ? to("listening", { partial: "", problem: "transcription_failed" })
        : state;
    case "tool_started":
      return state.phase === "thinking" ? to("executing") : state;
    case "tool_finished":
      return state.phase === "executing" ? to("thinking") : state;
    case "speaking":
      return REPLYING.has(state.phase) ? to("speaking", { partial: "" }) : state;
    case "speech_failed":
      // The text answer is already on screen; carry on.
      return state.phase === "idle" ? state : { ...state, problem: "speech_failed" };
    case "reply_done":
      if (!REPLYING.has(state.phase)) return state;
      if (event.awaitingApproval) return to("waiting_approval", { partial: "" });
      return state.continuous
        ? to("listening", { partial: "" })
        : to("sleeping", { partial: "", sleep: "inactivity" });
    case "barge_in":
      return REPLYING.has(state.phase) && state.bargeIn
        ? to("interrupted", { partial: "", problem: null })
        : state;
    case "interrupt":
      return REPLYING.has(state.phase) || state.phase === "interrupted"
        ? to("listening", { partial: "", problem: null })
        : state;
    case "mute":
      return HEARING.has(state.phase) ? to("muted", { partial: "" }) : state;
    case "unmute":
      return state.phase === "muted" ? to("listening", { problem: null }) : state;
    case "sleep":
      return ACTIVE.has(state.phase) ? to("sleeping", { sleep: event.reason, partial: "" }) : state;
    case "wake":
      return state.phase === "sleeping"
        ? to("arming", { sleep: null, problem: null, misses: 0 })
        : state;
    case "offline":
      return ACTIVE.has(state.phase) || state.phase === "sleeping"
        ? to("offline", { partial: "", problem: "network" })
        : state;
    case "online":
      return state.phase === "offline"
        ? to("sleeping", { sleep: "offline", problem: null })
        : state;
    case "wake_status":
      return { ...state, wake: event.status };
    case "end":
      return {
        ...initialVoice,
        speak: state.speak,
        bargeIn: state.bargeIn,
        continuous: state.continuous,
        wake: state.wake === "listening" ? "ready" : state.wake,
      };
  }
}

/** The microphone may be capturing for ELISE right now (the indicator must say so). */
export const micCapturing = (s: VoiceState) =>
  HEARING.has(s.phase) || (s.phase === "speaking" && s.bargeIn);
/** Back-compat name: the recorder is listening for the user's turn. */
export const micOpen = (s: VoiceState) => HEARING.has(s.phase);
/** The on-device wake engine is listening (only while asleep). */
export const wakeListening = (s: VoiceState) => s.phase === "sleeping" && s.wake === "listening";
/** A session exists (shown in the voice bar). */
export const inSession = (s: VoiceState) => s.phase !== "idle";
export const isReplying = (s: VoiceState) => REPLYING.has(s.phase);
export const isHearing = (s: VoiceState) => HEARING.has(s.phase);
