import type { VoiceTurnMeta } from "@/core/interaction";
import type { VoiceLanguage } from "@/core/voice/providers";
import { initialVoice, voiceReducer, type VoiceEvent, type VoiceState } from "@/core/voice/session";
import { SentenceChunker } from "@/core/voice/speech-text";

/**
 * One voice session (ADR-014), framework-free so it can be tested with fake audio:
 * microphone → transcript → the same chat turn as typing (modality "voice") → the streamed
 * reply spoken sentence by sentence while the Live Workspace assembles. It decides nothing
 * about the request itself; it only listens and speaks.
 */

export interface MicPort {
  open(): Promise<void>;
  begin(): void;
  finish(): Promise<{ blob: Blob; durationMs: number; heardSpeech: boolean }>;
  discard(): void;
  close(): void;
  level(): number;
  onSpeechEnd: (() => void) | null;
}

export interface PlayerPort {
  speak(text: string, language: VoiceLanguage | null): void;
  stop(): void;
  close(): void;
  level(): number;
  readonly speaking: boolean;
  onStart: (() => void) | null;
  onIdle: (() => void) | null;
  onError: (() => void) | null;
}

export type Transcriber = (
  audio: Blob,
  onPartial: (text: string) => void,
  signal: AbortSignal,
) => Promise<{ text: string; language: VoiceLanguage | null } | null>;

export type StreamEvent =
  | { type: "conversation" }
  | { type: "tool_started" }
  | { type: "text"; delta: string }
  | { type: "finished"; failed: boolean }
  | { type: string };

export type VoiceMarks = Partial<
  Record<
    | "speechEnd"
    | "transcriptFinal"
    | "runtimeStart"
    | "firstTool"
    | "firstText"
    | "audioStart"
    | "turnComplete",
    number
  >
>;

export interface VoiceDeps {
  createMic: () => MicPort;
  /** Called from the user's tap, so the browser allows playback. */
  createPlayer: () => PlayerPort;
  transcribe: Transcriber;
  send: (text: string, options: { modality: "voice"; voice: VoiceTurnMeta }) => void;
  onState: (state: VoiceState) => void;
  onTimings?: (marks: VoiceMarks) => void;
  now?: () => number;
  micProblem?: (error: unknown) => "permission_denied" | "no_microphone" | "not_supported";
}

interface SpokenTurn {
  language: VoiceLanguage | null;
  chunker: SentenceChunker;
  t0: number;
  marks: VoiceMarks;
  textDone: boolean;
  /** Characters spoken so far: past the limit the rest stays on screen. */
  spokenChars: number;
  capped: boolean;
}

/** Voice carries the synthesis; a long answer is spoken up to here, the rest is on screen. */
export const SPOKEN_LIMIT = 420;
const REST_ON_SCREEN = {
  es: "El resto te lo dejo en pantalla.",
  en: "The rest is on screen.",
} as const;

export class VoiceController {
  state: VoiceState;
  private mic: MicPort | null = null;
  private player: PlayerPort | null = null;
  private turn: SpokenTurn | null = null;
  private t0 = 0;
  private transcribing: AbortController | null = null;

  constructor(
    private deps: VoiceDeps,
    speak: boolean,
  ) {
    this.state = { ...initialVoice, speak };
  }

  /** The send function changes identity with React renders. */
  update(deps: Partial<VoiceDeps>) {
    this.deps = { ...this.deps, ...deps };
  }

  private get now() {
    return (this.deps.now ?? (() => performance.now()))();
  }

  private act(event: VoiceEvent) {
    this.state = voiceReducer(this.state, event);
    this.deps.onState(this.state);
  }

  async start() {
    if (this.state.phase !== "idle") return;
    if (this.state.speak && !this.player) {
      const p = this.deps.createPlayer();
      p.onStart = () => {
        if (this.turn) this.turn.marks.audioStart ??= Math.round(this.now - this.turn.t0);
        this.act({ type: "speaking" });
      };
      p.onIdle = () => {
        if (this.turn?.textDone) this.complete();
      };
      p.onError = () => this.act({ type: "speech_failed" });
      this.player = p;
    }
    this.act({ type: "start", speak: this.state.speak });
    const mic = this.deps.createMic();
    this.mic = mic;
    try {
      await mic.open();
      this.act({ type: "mic_ready" });
      this.listen();
    } catch (error) {
      mic.close();
      this.mic = null;
      this.act({ type: "mic_failed", problem: this.deps.micProblem?.(error) ?? "not_supported" });
    }
  }

  private listen() {
    const mic = this.mic;
    if (!mic || this.state.phase !== "listening") return;
    mic.onSpeechEnd = () => void this.finishUtterance();
    this.t0 = this.now;
    mic.begin();
  }

  /** Tap while listening: that's all I wanted to say. */
  finishNow() {
    void this.finishUtterance();
  }

  private async finishUtterance() {
    const mic = this.mic;
    if (!mic || this.state.phase !== "listening") return;
    this.act({ type: "speech_end" });
    const speechEnd = Math.round(this.now - this.t0);
    const utterance = await mic.finish();
    if (!utterance.heardSpeech || !utterance.blob.size) {
      this.act({ type: "transcript", text: "" });
      this.listen();
      return;
    }
    const controller = new AbortController();
    this.transcribing = controller;
    const result = await this.deps.transcribe(
      utterance.blob,
      (text) => this.act({ type: "partial", text }),
      controller.signal,
    );
    this.transcribing = null;
    if (this.phase() !== "transcribing") return; // ended meanwhile
    if (!result) {
      // Never invent what the user said: say so and listen again.
      this.act({ type: "transcription_failed" });
      this.listen();
      return;
    }
    this.act({ type: "transcript", text: result.text });
    if (!result.text.trim()) {
      this.listen();
      return;
    }
    this.turn = {
      language: result.language,
      chunker: new SentenceChunker(),
      t0: this.t0,
      marks: { speechEnd, transcriptFinal: Math.round(this.now - this.t0) },
      textDone: false,
      spokenChars: 0,
      capped: false,
    };
    this.deps.send(result.text, {
      modality: "voice",
      voice: { durationMs: utterance.durationMs, language: result.language },
    });
  }

  private phase() {
    return this.state.phase;
  }

  /** The chat stream of the spoken turn: its text is spoken as it arrives. */
  onStream(event: StreamEvent) {
    const turn = this.turn;
    if (!turn) return;
    const since = () => Math.round(this.now - turn.t0);
    if (event.type === "conversation") turn.marks.runtimeStart ??= since();
    else if (event.type === "tool_started") turn.marks.firstTool ??= since();
    else if (event.type === "text" && "delta" in event) {
      turn.marks.firstText ??= since();
      for (const sentence of turn.chunker.push(event.delta)) this.say(turn, sentence);
    } else if (event.type === "finished") {
      for (const sentence of turn.chunker.flush()) this.say(turn, sentence);
      turn.textDone = true;
      if (!this.player?.speaking) this.complete();
    }
  }

  private say(turn: SpokenTurn, sentence: string) {
    if (turn.capped) return;
    if (turn.spokenChars > 0 && turn.spokenChars + sentence.length > SPOKEN_LIMIT) {
      turn.capped = true;
      this.player?.speak(REST_ON_SCREEN[turn.language ?? "es"], turn.language);
      return;
    }
    turn.spokenChars += sentence.length;
    this.player?.speak(sentence, turn.language);
  }

  private complete() {
    const turn = this.turn;
    if (!turn) return;
    turn.marks.turnComplete = Math.round(this.now - turn.t0);
    this.turn = null;
    this.deps.onTimings?.(turn.marks);
    this.act({ type: "reply_done" });
    this.listen();
  }

  /** Tap while ELISE speaks or thinks: stop her and listen; the reply so far stays on screen. */
  interrupt() {
    if (this.state.phase !== "speaking" && this.state.phase !== "thinking") return;
    this.player?.stop();
    if (this.turn)
      this.deps.onTimings?.({
        ...this.turn.marks,
        turnComplete: Math.round(this.now - this.turn.t0),
      });
    this.turn = null;
    this.act({ type: "interrupt" });
    this.listen();
  }

  toggleMute() {
    if (this.state.phase === "muted") {
      this.act({ type: "unmute" });
      this.listen();
    } else if (this.state.phase === "listening") {
      this.mic?.discard();
      this.act({ type: "mute" });
    }
  }

  /** Ends the session: the microphone is released at once. */
  end() {
    this.transcribing?.abort();
    this.mic?.close();
    this.mic = null;
    this.player?.stop();
    this.turn = null;
    this.act({ type: "end" });
  }

  dispose() {
    this.end();
    this.player?.close();
    this.player = null;
  }

  /** Real amplitude for the Orb: the microphone while listening, ELISE while speaking. */
  level(): number {
    if (this.state.phase === "listening") return this.mic?.level() ?? 0;
    if (this.state.phase === "speaking") return this.player?.level() ?? 0;
    return -1;
  }
}
