/**
 * Voice session lifecycle (ADR-014), as a pure reducer shared by the UI and tests:
 *
 *   idle ─start→ listening ─speech end→ transcribing ─transcript→ thinking ─reply→ speaking
 *     ↑              ↑  │                                  │                        │
 *     └──── end ─────┴──┴─ mute → muted ─ unmute ┘         └─ no speech → listening ┘ (continue)
 *
 * The microphone is open only in `listening`. Interrupting ELISE (tap) stops playback and
 * listens again; the reply already generated is kept in the conversation.
 */

export type VoicePhase = "idle" | "listening" | "muted" | "transcribing" | "thinking" | "speaking";

export type VoiceProblem =
  | "permission_denied"
  | "no_microphone"
  | "not_supported"
  | "transcription_failed"
  | "nothing_heard"
  | "speech_failed"
  | "network";

export interface VoiceState {
  phase: VoicePhase;
  /** The transcript as it is recognized (shown subtly while transcribing). */
  partial: string;
  problem: VoiceProblem | null;
  /** Speaking back is on (the user may keep voice input with text-only replies). */
  speak: boolean;
  /** Utterances in a row with nothing recognized: after two, the session pauses. */
  misses: number;
}

export type VoiceEvent =
  | { type: "start"; speak: boolean }
  | { type: "mic_ready" }
  | { type: "mic_failed"; problem: "permission_denied" | "no_microphone" | "not_supported" }
  | { type: "speech_end" }
  | { type: "partial"; text: string }
  | { type: "transcript"; text: string }
  | { type: "transcription_failed" }
  | { type: "speaking" }
  | { type: "speech_failed" }
  | { type: "reply_done" }
  | { type: "interrupt" }
  | { type: "mute" }
  | { type: "unmute" }
  | { type: "end" };

export const initialVoice: VoiceState = {
  phase: "idle",
  partial: "",
  problem: null,
  speak: true,
  misses: 0,
};

const MAX_MISSES = 2;

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "start":
      return { ...initialVoice, phase: "listening", speak: event.speak };
    case "mic_ready":
      return state.phase === "listening" ? { ...state, problem: null } : state;
    case "mic_failed":
      return { ...state, phase: "idle", problem: event.problem };
    case "speech_end":
      return state.phase === "listening" ? { ...state, phase: "transcribing", partial: "" } : state;
    case "partial":
      return state.phase === "transcribing" ? { ...state, partial: event.text } : state;
    case "transcript": {
      if (state.phase !== "transcribing") return state;
      if (!event.text.trim()) {
        // Never invent what the user said: nothing heard means listen again (then pause).
        const misses = state.misses + 1;
        return misses >= MAX_MISSES
          ? { ...state, phase: "idle", partial: "", problem: "nothing_heard", misses }
          : { ...state, phase: "listening", partial: "", problem: "nothing_heard", misses };
      }
      return { ...state, phase: "thinking", partial: event.text, problem: null, misses: 0 };
    }
    case "transcription_failed":
      return state.phase === "transcribing"
        ? { ...state, phase: "listening", partial: "", problem: "transcription_failed" }
        : state;
    case "speaking":
      return state.phase === "thinking" || state.phase === "speaking"
        ? { ...state, phase: "speaking", partial: "" }
        : state;
    case "speech_failed":
      // The text answer is already on screen; carry on listening.
      return state.phase === "idle" ? state : { ...state, problem: "speech_failed" };
    case "reply_done":
      return state.phase === "thinking" || state.phase === "speaking"
        ? { ...state, phase: "listening", partial: "" }
        : state;
    case "interrupt":
      return state.phase === "speaking" || state.phase === "thinking"
        ? { ...state, phase: "listening", partial: "", problem: null }
        : state;
    case "mute":
      return state.phase === "listening" ? { ...state, phase: "muted" } : state;
    case "unmute":
      return state.phase === "muted" ? { ...state, phase: "listening", problem: null } : state;
    case "end":
      return { ...initialVoice, speak: state.speak };
  }
}

/** Is the microphone allowed to be open? Only while listening. */
export const micOpen = (s: VoiceState) => s.phase === "listening";
export const inSession = (s: VoiceState) => s.phase !== "idle";
