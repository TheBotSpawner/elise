/**
 * Speech providers (ADR-014): the capabilities ELISE needs from speech, not a vendor's SDK.
 * Voice is an interface into the same runtime — these only turn audio into a user turn and a
 * reply into audio. Implementations live in infrastructure.
 */

export type VoiceLanguage = "es" | "en";

export interface TranscriptionRequest {
  audio: Uint8Array;
  mimeType: string;
  /** A fixed language, or null to detect it (ELISE speaks Spanish and English). */
  language: VoiceLanguage | null;
  /** Names and terms worth recognizing (the user's name, visible topics…). Not instructions. */
  context?: string;
}

export type TranscriptionEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string; language: VoiceLanguage | null };

export interface SpeechInputProvider {
  readonly id: string;
  readonly model: string;
  /** Streams the transcript as it is recognized; ends with exactly one `final`. */
  transcribe(
    request: TranscriptionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TranscriptionEvent>;
}

/** Raw 16-bit little-endian mono PCM: plays progressively and exposes real amplitude. */
export interface SpeechAudioFormat {
  encoding: "pcm_s16le";
  sampleRate: number;
}

export interface SynthesisRequest {
  text: string;
  language: VoiceLanguage;
  voice: string;
}

export interface SpeechOutputProvider {
  readonly id: string;
  readonly model: string;
  readonly format: SpeechAudioFormat;
  /** Voices a user may pick (allowlisted; the provider may offer more). */
  readonly voices: readonly string[];
  synthesize(request: SynthesisRequest, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

/** Upper bounds that keep a turn cheap and private (no long recordings, no essays read aloud). */
export const VOICE_LIMITS = {
  maxAudioBytes: 6 * 1024 * 1024,
  maxUtteranceMs: 60_000,
  maxSpokenChars: 600,
  audioTypes: ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav"],
} as const;

export const VOICES = ["marin", "cedar", "coral", "sage", "ash", "verse"] as const;
export type VoiceName = (typeof VOICES)[number];
