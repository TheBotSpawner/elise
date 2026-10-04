import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import { ELEVEN_PROFILES, OPENAI_PROFILES, PREVIEW_TEXT } from "@/core/voice/profiles";
import { VOICE_LIMITS, type VoiceChoice, type VoiceLanguage } from "@/core/voice/providers";
import { formatForSpeech } from "@/core/voice/speech-format";
import { acknowledgements } from "@/core/voice/speech-plan";
import { toSpeakable } from "@/core/voice/speech-text";
import { elevenVoices, getSpeechInputProvider, getSpeechOutputProvider } from "@/infrastructure/ai";
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
  previous?: string,
): Promise<{ stream: ReadableStream<Uint8Array>; sampleRate: number }> {
  if (!auth.profile.voice.enabled || !auth.profile.voice.speak)
    throw new AppError("PERMISSION_DENIED", "Spoken replies are turned off in Settings", {
      recovery: "review",
    });
  limit(auth, "speak");
  const lang = language ?? auth.profile.locale;
  // Said as a person would say it: same facts, spoken form (ADR-030).
  const spoken = formatForSpeech(text, lang).slice(0, VOICE_LIMITS.maxSpokenChars);
  if (!spoken) throw new AppError("VALIDATION_ERROR", "Nothing to say");
  const provider = getSpeechOutputProvider();
  // The acknowledgements (ADR-028) are a few fixed lines: synthesized once per instance and
  // voice, then served from memory, so "Lo busco." plays while the work starts, not ~2 s later.
  const fixed = ACKNOWLEDGEMENT_LINES.has(spoken);
  const key = ackKey(provider, auth.profile.voice.voice, lang, spoken);
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
      {
        text: spoken,
        language: lang,
        voice: auth.profile.voice.voice,
        ...(previous ? { previousText: formatForSpeech(previous, lang) } : {}),
      },
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

/**
 * Synthesizes, in the user's current provider and voice, the acknowledgement lines this
 * instance doesn't hold yet (ADR-034): the first "Reviso tu agenda." then plays from memory.
 * Fixed, non-personal text; sequential and bounded. Returns how many were synthesized.
 */
export async function warmAcknowledgements(auth: AuthContext, language: VoiceLanguage) {
  if (!auth.profile.voice.enabled || !auth.profile.voice.speak) return 0;
  const provider = getSpeechOutputProvider();
  let made = 0;
  for (const line of acknowledgements(language).map((l) => formatForSpeech(l, language))) {
    const key = ackKey(provider, auth.profile.voice.voice, language, line);
    if (ackAudio.has(key)) continue;
    const scope = { workspaceId: auth.workspaceId, userId: auth.userId, feature: "voice" };
    const stream = await withUsageScope(scope, () =>
      provider.synthesize(
        { text: line, language, voice: auth.profile.voice.voice },
        AbortSignal.timeout(SPEAK_TIMEOUT_MS),
      ),
    ).catch(() => null);
    if (!stream) break; // the provider is struggling: stop, the lines synthesize on demand
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (bytes.byteLength) ackAudio.set(key, bytes);
    made++;
  }
  return made;
}

const ACKNOWLEDGEMENT_LINES = new Set([
  ...acknowledgements("es").map(toSpeakable),
  ...acknowledgements("en").map(toSpeakable),
]);
// Bounded by construction: ~30 fixed lines × the few voices (~40 KB each). Not user content.
const ackAudio = new Map<string, Uint8Array>();

/**
 * Bump to drop every cached acknowledgement (new lines' wording, a formatting change). The
 * provider, its model, the voice and the language are part of the key, so changing any of
 * them never plays audio made for another (ADR-036).
 */
const ACK_CACHE_VERSION = 2;
export const ackKey = (
  provider: { id: string; model: string },
  voice: string,
  language: string,
  line: string,
) => `${ACK_CACHE_VERSION}|${provider.id}|${provider.model}|${voice}|${language}|${line}`;

/**
 * What Settings shows about spoken replies (ADR-030): which provider speaks and the curated
 * voices to choose from — display names only, never provider ids, keys or model names.
 */
export function speechStatus(): {
  provider: "elevenlabs" | "openai";
  profiles: { id: VoiceChoice; displayName: string }[];
} {
  const env = serverEnv();
  const eleven = elevenVoices();
  const active =
    env.SPEECH_PROVIDER === "elevenlabs" && env.ELEVENLABS_API_KEY && Object.keys(eleven).length;
  return active
    ? {
        provider: "elevenlabs",
        profiles: ELEVEN_PROFILES.filter((p) => eleven[p.id]).map((p) => ({
          id: p.id as VoiceChoice,
          displayName: p.displayName,
        })),
      }
    : {
        provider: "openai",
        profiles: OPENAI_PROFILES.map((p) => ({
          id: p.id as VoiceChoice,
          displayName: p.displayName,
        })),
      };
}

/** A short fixed sample in one of the selectable voices (never the user's own content). */
export async function previewVoice(
  auth: AuthContext,
  voice: VoiceChoice,
  language: VoiceLanguage,
): Promise<{ stream: ReadableStream<Uint8Array>; sampleRate: number }> {
  if (!speechStatus().profiles.some((p) => p.id === voice))
    throw new AppError("VALIDATION_ERROR", "That voice isn't available", { recovery: "review" });
  limit(auth, "speak");
  const provider = getSpeechOutputProvider();
  const stream = await provider.synthesize({ text: PREVIEW_TEXT[language], language, voice });
  return { stream, sampleRate: provider.format.sampleRate };
}

/** Latency of one voice turn, in milliseconds from the moment the microphone opened. */
export const VOICE_TIMINGS = [
  "lastVoice",
  "speechEnd",
  "turnDetected",
  "speculative",
  "endVerdict",
  "continuation",
  "transcriptFinal",
  "runtimeStart",
  "ackReady",
  "ackTts",
  "progressTts",
  "firstTool",
  "firstSurface",
  "toolsDone",
  "firstText",
  "resultSpeech",
  "audioStart",
  "turnComplete",
  /** Spoken segments of the reply, their average size, the longest silence between them. */
  "segments",
  "avgSegmentChars",
  "maxGapMs",
  "firstAudioMs",
] as const;

/**
 * A turn's latency split into its stages (ADR-036), each measured on its own:
 *   turn_detection    the user stopped talking → ELISE decided the turn was over
 *   stt_finalization  turn over → final transcript
 *   ack_selection     final transcript → acknowledgement chosen
 *   tts_first_audio   acknowledgement (or answer) chosen → first audio playing
 *   perceived         the user stopped talking → ELISE's first audio
 */
export function voiceStages(t: Partial<Record<(typeof VOICE_TIMINGS)[number], number>>) {
  const span = (from?: number, to?: number) =>
    from !== undefined && to !== undefined && to >= from ? to - from : undefined;
  const firstLine = t.ackReady ?? t.resultSpeech;
  return {
    turn_detection_ms: span(t.lastVoice, t.turnDetected ?? t.speechEnd),
    stt_finalization_ms: span(t.turnDetected ?? t.speechEnd, t.transcriptFinal),
    ack_selection_ms: span(t.transcriptFinal, t.ackReady),
    tts_first_audio_ms: span(firstLine, t.audioStart),
    perceived_ms: span(t.lastVoice, t.audioStart),
  };
}

export function recordVoiceTimings(
  auth: AuthContext,
  timings: Partial<Record<(typeof VOICE_TIMINGS)[number], number>>,
) {
  // Numbers only: no audio, no transcript, no content.
  logger.info("voice.turn_timing", {
    workspace_id: auth.workspaceId,
    ...timings,
    ...voiceStages(timings),
  });
}
