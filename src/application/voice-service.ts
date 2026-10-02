import "server-only";

import { AppError } from "@/core/errors";
import { VOICE_LIMITS, type VoiceLanguage } from "@/core/voice/providers";
import { acknowledgements } from "@/core/voice/speech-plan";
import { toSpeakable } from "@/core/voice/speech-text";
import { getSpeechInputProvider, getSpeechOutputProvider } from "@/infrastructure/ai";
import { logger } from "@/infrastructure/observability/logger";
import { withUsageScope } from "@/infrastructure/observability/usage";
import { rateLimit } from "@/infrastructure/rate-limit";

import type { AuthContext } from "./auth-context";

/**
 * Voice I/O (ADR-014). Audio is handled in memory for the length of one request and never
 * stored or logged; only the transcript enters the interaction, as ordinary user input.
 */

const LIMITS = { transcribe: 40, speak: 160 } as const;
/** A provider that stops answering must not leave the voice session waiting forever. */
const TRANSCRIBE_TIMEOUT_MS = 20_000;
const SPEAK_TIMEOUT_MS = 15_000;

function limit(auth: AuthContext, kind: keyof typeof LIMITS) {
  rateLimit(
    `voice.${kind}:${auth.userId}`,
    LIMITS[kind],
    60_000,
    "Too many voice requests. Wait a moment and try again.",
  );
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

  const scope = { workspaceId: auth.workspaceId, userId: auth.userId, feature: "voice" };
  return withUsageScope(
    scope,
    () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (e: TranscribeStreamEvent) =>
            controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
          try {
            for await (const event of provider.transcribe(
              {
                audio: bytes,
                mimeType: audio.type,
                language,
                // Recognition hints only (names), never instructions.
                context: auth.profile.displayName
                  ? `Speaker: ${auth.profile.displayName}. Assistant: ELISE.`
                  : "Assistant: ELISE.",
              },
              AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
            )) {
              if (event.type === "partial") send(event);
              else send({ ...event, ms: Date.now() - started });
            }
            logger.info("voice.transcribed", {
              model: provider.model,
              bytes: bytes.length,
              latency_ms: Date.now() - started,
            });
          } catch (error) {
            const code =
              error instanceof AppError
                ? error.code
                : error instanceof DOMException && error.name === "TimeoutError"
                  ? "TIMEOUT"
                  : "PROVIDER_UNAVAILABLE";
            logger.warn("voice.transcription_failed", {
              code,
              provider_status:
                error instanceof AppError ? error.details?.providerStatus : undefined,
              bytes: bytes.length,
              mime: type,
            });
            send({ type: "error", code });
          } finally {
            controller.close();
          }
        },
      }),
  );
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
  // The acknowledgements (ADR-028) are a few fixed lines: synthesized once per instance and
  // voice, then served from memory, so "Lo busco." plays while the work starts, not ~2 s later.
  const fixed = ACKNOWLEDGEMENT_LINES.has(spoken);
  const key = `${auth.profile.voice.voice}|${spoken}`;
  const cached = fixed ? ackAudio.get(key) : undefined;
  if (cached)
    return {
      stream: new ReadableStream({
        start(c) {
          c.enqueue(cached);
          c.close();
        },
      }),
      sampleRate: provider.format.sampleRate,
    };
  const scope = { workspaceId: auth.workspaceId, userId: auth.userId, feature: "voice" };
  const stream = await withUsageScope(scope, () =>
    provider.synthesize(
      { text: spoken, language: language ?? auth.profile.locale, voice: auth.profile.voice.voice },
      AbortSignal.timeout(SPEAK_TIMEOUT_MS),
    ),
  );
  if (!fixed) return { stream, sampleRate: provider.format.sampleRate };
  const [live, copy] = stream.tee();
  void new Response(copy)
    .arrayBuffer()
    .then((b) => b.byteLength && ackAudio.set(key, new Uint8Array(b)))
    .catch(() => undefined);
  return { stream: live, sampleRate: provider.format.sampleRate };
}

const ACKNOWLEDGEMENT_LINES = new Set([
  ...acknowledgements("es").map(toSpeakable),
  ...acknowledgements("en").map(toSpeakable),
]);
// Bounded by construction: ~30 fixed lines × the few voices (~40 KB each). Not user content.
const ackAudio = new Map<string, Uint8Array>();

/** Latency of one voice turn, in milliseconds from the moment the microphone opened. */
export const VOICE_TIMINGS = [
  "speechEnd",
  "transcriptFinal",
  "runtimeStart",
  "ackReady",
  "ackTts",
  "firstTool",
  "firstSurface",
  "toolsDone",
  "firstText",
  "resultSpeech",
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
