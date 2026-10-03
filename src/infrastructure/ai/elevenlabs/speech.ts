import "server-only";

import { AppError } from "@/core/errors";
import type { SpeechOutputProvider, SynthesisRequest, VoiceLanguage } from "@/core/voice/providers";
import { recordUsage } from "@/infrastructure/observability/usage";

/**
 * ElevenLabs speech output (ADR-030), verified against the current docs (2026-10-02):
 * - `eleven_v4_turbo` (and v3/v4 conversational models) only stream through the Text to
 *   Dialogue WebSocket `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input`: first frame
 *   `{ voices: [id], xi_api_key }`, then `{ inputs: [{ text, voice_id }] }` and `{ flush: true }`;
 *   audio arrives as base64 `audio` frames until `is_final` / `is_final_audio_for_turn`.
 * - Other models (`eleven_flash_v2_5`, `eleven_multilingual_v2`…) use HTTP streaming
 *   `POST /v1/text-to-speech/{voice_id}/stream`, which takes `previous_text` so a segment
 *   continues the prosody of the one before it.
 * Both return raw 16-bit PCM at 24 kHz (`pcm_24000`), the format ELISE's player schedules.
 * The API key stays on this server: the browser only ever receives audio.
 */

const API = "https://api.elevenlabs.io/v1";
const TDD = "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input";
const FORMAT = "pcm_24000";

/** Models that only stream through Text to Dialogue (WebSocket). */
export const isDialogueModel = (model: string) => /^eleven_v(3|4)/.test(model);

/** Voice character, centralised: calm, warm, confident — never theatrical (ADR-030 §profile). */
export interface ElevenVoiceSettings {
  stability: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
}

export interface ElevenUsage {
  model: string;
  characters: number;
  /** Request (or socket open) → first audio byte. */
  firstAudioMs: number | null;
}

/** Strips anything the model wrote in provider control syntax ([laughs], <break/>…). */
export function sanitizeForProvider(text: string): string {
  return text
    .replace(/\[[^\]]{1,40}\]/g, " ")
    .replace(/<[^>]{1,60}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export class ElevenLabsSpeechOutput implements SpeechOutputProvider {
  readonly id = "elevenlabs";
  readonly format = { encoding: "pcm_s16le", sampleRate: 24_000 } as const;
  readonly voices: readonly string[];

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    /** Curated voice profiles' provider voice ids, by profile id (no secrets in profiles). */
    private readonly voiceIds: Readonly<Record<string, string>>,
    private readonly settings: ElevenVoiceSettings,
    private readonly onUsage: (u: ElevenUsage) => void = () => undefined,
  ) {
    this.voices = Object.keys(voiceIds);
  }

  private voiceFor(profile: string): string {
    return this.voiceIds[profile] ?? Object.values(this.voiceIds)[0]!;
  }

  async synthesize(
    request: SynthesisRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const text = sanitizeForProvider(request.text);
    if (!text) throw new AppError("VALIDATION_ERROR", "Nothing to say");
    const voice = this.voiceFor(request.voice);
    return isDialogueModel(this.model)
      ? this.dialogue(text, voice, request.language, signal)
      : this.http(text, voice, request, signal);
  }

  /** HTTP streaming (flash/multilingual): previous_text keeps the voice continuous. */
  private async http(
    text: string,
    voice: string,
    request: SynthesisRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const started = Date.now();
    const res = await fetch(
      `${API}/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=${FORMAT}`,
      {
        method: "POST",
        headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: this.model,
          language_code: request.language,
          voice_settings: this.settings,
          ...(request.previousText
            ? { previous_text: sanitizeForProvider(request.previousText).slice(-500) }
            : {}),
        }),
        signal,
      },
    );
    if (!res.ok || !res.body) throw failure(res.status);
    this.report(text, started, Date.now() - started);
    return res.body;
  }

  /**
   * One Text to Dialogue exchange: open, register the voice, send the segment, flush, stream
   * the audio back, close. ponytail: a socket per segment (serverless-safe, key server-only);
   * one persistent browser socket per Voice session needs a frontend token for this endpoint.
   */
  private dialogue(
    text: string,
    voice: string,
    language: VoiceLanguage,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const started = Date.now();
    const url = `${TDD}?model_id=${encodeURIComponent(this.model)}&output_format=${FORMAT}&language_code=${language}`;
    const socket = new WebSocket(url);
    let firstAudio: number | null = null;
    return new Promise((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let settled = false;
      const fail = (error: AppError) => {
        if (!settled) {
          settled = true;
          reject(error);
        } else controller?.error(error);
        socket.close();
      };
      const finish = () => {
        controller?.close();
        controller = null;
        socket.close();
        this.report(text, started, firstAudio);
      };
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          socket.close();
        },
      });
      signal?.addEventListener("abort", () =>
        fail(new AppError("PROVIDER_UNAVAILABLE", "Speech cancelled")),
      );
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            voices: [voice],
            xi_api_key: this.apiKey,
            voice_settings: this.settings,
          }),
        );
        socket.send(JSON.stringify({ inputs: [{ text, voice_id: voice }] }));
        socket.send(JSON.stringify({ flush: true }));
      };
      socket.onmessage = (event) => {
        let msg: {
          audio?: string;
          is_final?: boolean;
          is_final_audio_for_turn?: boolean;
          error?: string;
          code?: number;
        };
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (msg.error) return fail(failure(msg.code ?? 500));
        if (msg.audio) {
          const bytes = Uint8Array.from(Buffer.from(msg.audio, "base64"));
          if (!bytes.length) return;
          if (firstAudio === null) firstAudio = Date.now() - started;
          // Audio flows only once the first chunk proves synthesis works (failover stays clean).
          if (!settled) {
            settled = true;
            resolve(stream);
          }
          controller?.enqueue(bytes);
        }
        if (msg.is_final || msg.is_final_audio_for_turn) {
          if (!settled) {
            settled = true;
            resolve(stream);
          }
          finish();
        }
      };
      socket.onerror = () => fail(failure(503));
      socket.onclose = () => {
        if (!settled) fail(failure(503));
        else if (controller) finish();
      };
    });
  }

  private report(text: string, started: number, firstAudioMs: number | null) {
    recordUsage({
      operation: "speech",
      provider: this.id,
      model: this.model,
      units: text.length,
      unit: "characters",
      latencyMs: firstAudioMs ?? Date.now() - started,
    });
    this.onUsage({ model: this.model, characters: text.length, firstAudioMs });
  }
}

function failure(status: number): AppError {
  if (status === 401 || status === 403)
    return new AppError("AI_NOT_CONFIGURED", "ElevenLabs isn't configured correctly", {
      recovery: "configure",
    });
  if (status === 429)
    return new AppError("RATE_LIMITED", "ElevenLabs is busy", { recovery: "retry" });
  // The provider's message stays out of the error: it could echo the text being spoken.
  return new AppError("PROVIDER_UNAVAILABLE", "ElevenLabs couldn't synthesize speech", {
    recovery: "retry",
  });
}
