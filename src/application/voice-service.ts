import "server-only";

import { AppError } from "@/core/errors";
import { VOICE_LIMITS, type VoiceLanguage } from "@/core/voice/providers";
import { toSpeakable } from "@/core/voice/speech-text";
import { getSpeechInputProvider, getSpeechOutputProvider } from "@/infrastructure/ai";
import { logger } from "@/infrastructure/observability/logger";

import type { AuthContext } from "./auth-context";

/**
 * Voice I/O (ADR-014). Audio is handled in memory for the length of one request and never
 * stored or logged; only the transcript enters the interaction, as ordinary user input.
 */

const WINDOW_MS = 60_000;
const LIMITS = { transcribe: 40, speak: 160 } as const;
// ponytail: per-instance window; move to a shared store if abuse across instances matters.
const hits = new Map<string, number[]>();

function limit(auth: AuthContext, kind: keyof typeof LIMITS) {
  const key = `${kind}:${auth.userId}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMITS[kind])
    throw new AppError("RATE_LIMITED", "Too many voice requests. Wait a moment and try again.");
  recent.push(now);
  hits.set(key, recent);
}

export type TranscribeStreamEvent =
  | { type: "partial"; text: string }
  | { type: "final"; text: string; language: VoiceLanguage | null; ms: number }
  | { type: "error"; code: string };

/** One utterance → transcript events (NDJSON). Nothing is invented: silence gives "". */
export async function transcribeUtterance(
  auth: AuthContext,
  audio: File,
): Promise<ReadableStream<Uint8Array>> {
  if (!auth.profile.voice.enabled)
    throw new AppError("PERMISSION_DENIED", "Voice is turned off in Settings", {
      recovery: "review",
    });
  limit(auth, "transcribe");
  const type = audio.type.split(";")[0] ?? "";
  if (!(VOICE_LIMITS.audioTypes as readonly string[]).includes(type))
    throw new AppError("VALIDATION_ERROR", "Unsupported audio format");
  if (audio.size === 0 || audio.size > VOICE_LIMITS.maxAudioBytes)
    throw new AppError("VALIDATION_ERROR", "That recording is empty or too long");
  const provider = getSpeechInputProvider();
  const bytes = new Uint8Array(await audio.arrayBuffer());
  const language = auth.profile.voice.language === "auto" ? null : auth.profile.voice.language;
  const started = Date.now();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: TranscribeStreamEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        for await (const event of provider.transcribe({
          audio: bytes,
          mimeType: audio.type,
          language,
          // Recognition hints only (names), never instructions.
          context: auth.profile.displayName
            ? `Speaker: ${auth.profile.displayName}. Assistant: ELISE.`
            : "Assistant: ELISE.",
        })) {
          if (event.type === "partial") send(event);
          else send({ ...event, ms: Date.now() - started });
        }
        logger.info("voice.transcribed", {
          model: provider.model,
          bytes: bytes.length,
          latency_ms: Date.now() - started,
        });
      } catch (error) {
        const code = error instanceof AppError ? error.code : "PROVIDER_UNAVAILABLE";
        logger.warn("voice.transcription_failed", { code });
        send({ type: "error", code });
      } finally {
        controller.close();
      }
    },
  });
}

/** One sentence of the reply → streamed PCM audio (spoken text is sanitized, capped). */
export async function synthesizeSentence(
  auth: AuthContext,
  text: string,
  language: VoiceLanguage | null,
): Promise<{ stream: ReadableStream<Uint8Array>; sampleRate: number }> {
  if (!auth.profile.voice.enabled || !auth.profile.voice.speak)
    throw new AppError("PERMISSION_DENIED", "Spoken replies are turned off in Settings", {
      recovery: "review",
    });
  limit(auth, "speak");
  const spoken = toSpeakable(text).slice(0, VOICE_LIMITS.maxSpokenChars);
  if (!spoken) throw new AppError("VALIDATION_ERROR", "Nothing to say");
  const provider = getSpeechOutputProvider();
  const stream = await provider.synthesize({
    text: spoken,
    language: language ?? auth.profile.locale,
    voice: auth.profile.voice.voice,
  });
  return { stream, sampleRate: provider.format.sampleRate };
}

/** Latency of one voice turn, in milliseconds from the moment the microphone opened. */
export const VOICE_TIMINGS = [
  "speechEnd",
  "transcriptFinal",
  "runtimeStart",
  "firstTool",
  "firstText",
  "audioStart",
  "turnComplete",
] as const;

export function recordVoiceTimings(
  auth: AuthContext,
  timings: Partial<Record<(typeof VOICE_TIMINGS)[number], number>>,
) {
  // Numbers only: no audio, no transcript, no content.
  logger.info("voice.turn_timing", { workspace_id: auth.workspaceId, ...timings });
}
