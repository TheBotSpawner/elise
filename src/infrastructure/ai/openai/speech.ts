import "server-only";

import { AppError } from "@/core/errors";
import {
  VOICES,
  type SpeechInputProvider,
  type SpeechOutputProvider,
  type SynthesisRequest,
  type TranscriptionEvent,
  type TranscriptionRequest,
  type VoiceLanguage,
} from "@/core/voice/providers";

/**
 * OpenAI speech (verified against the current API, 2026-09):
 * - input: POST /v1/audio/transcriptions with `gpt-transcribe`, `stream=true` → SSE
 *   `transcript.text.delta` / `transcript.text.done` (the done event reports the language);
 * - output: POST /v1/audio/speech with `gpt-4o-mini-tts`, `response_format=pcm` → a stream of
 *   24 kHz 16-bit mono PCM that starts in ~1.3 s and plays while it arrives.
 * Audio is sent from memory and never stored.
 */

const API = "https://api.openai.com/v1";
const EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

function providerError(status: number, fallback: string): AppError {
  if (status === 401 || status === 403)
    return new AppError("AI_NOT_CONFIGURED", "Speech isn't configured correctly", {
      recovery: "configure",
    });
  if (status === 429)
    return new AppError("RATE_LIMITED", "Speech is busy right now. Try again in a moment.");
  return new AppError("PROVIDER_UNAVAILABLE", fallback, { recovery: "retry" });
}

const asLanguage = (code: unknown): VoiceLanguage | null =>
  typeof code === "string" && /^(es|en)/i.test(code)
    ? (code.slice(0, 2).toLowerCase() as VoiceLanguage)
    : null;

export class OpenAISpeechInput implements SpeechInputProvider {
  readonly id = "openai";
  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async *transcribe(
    request: TranscriptionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<TranscriptionEvent> {
    const form = new FormData();
    const type = request.mimeType.split(";")[0]!;
    form.append(
      "file",
      new Blob([request.audio as BlobPart], { type }),
      `speech.${EXT[type] ?? "webm"}`,
    );
    form.append("model", this.model);
    form.append("stream", "true");
    if (request.language) form.append("language", request.language);
    if (request.context) form.append("prompt", request.context.slice(0, 800));
    const res = await fetch(`${API}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal,
    });
    if (!res.ok || !res.body) throw providerError(res.status, "Couldn't transcribe the audio");

    let text = "";
    let buffer = "";
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data) as {
          type: string;
          delta?: string;
          text?: string;
          languages?: { code?: string }[];
        };
        if (event.type === "transcript.text.delta" && event.delta) {
          text += event.delta;
          yield { type: "partial", text };
        } else if (event.type === "transcript.text.done") {
          yield {
            type: "final",
            text: (event.text ?? text).trim(),
            language: asLanguage(event.languages?.[0]?.code),
          };
          return;
        }
      }
    }
    yield { type: "final", text: text.trim(), language: null };
  }
}

const STYLE: Record<VoiceLanguage, string> = {
  es: "Hablá en español rioplatense, natural, cálido y claro, a ritmo de conversación. Sin exagerar.",
  en: "Speak naturally, warm and clear, at a conversational pace. Understated, never theatrical.",
};

export class OpenAISpeechOutput implements SpeechOutputProvider {
  readonly id = "openai";
  readonly format = { encoding: "pcm_s16le", sampleRate: 24_000 } as const;
  readonly voices = VOICES;
  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async synthesize(
    request: SynthesisRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await fetch(`${API}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        voice: (VOICES as readonly string[]).includes(request.voice) ? request.voice : VOICES[0],
        input: request.text,
        response_format: "pcm",
        instructions: STYLE[request.language],
      }),
      signal,
    });
    if (!res.ok || !res.body) throw providerError(res.status, "Couldn't synthesize speech");
    return res.body;
  }
}
