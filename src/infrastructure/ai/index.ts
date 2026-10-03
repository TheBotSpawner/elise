import "server-only";

import { serverEnv } from "@/config/server-env";
import type { AIProvider } from "@/core/agents/ai-provider";
import { AppError } from "@/core/errors";
import type { EmbeddingProvider } from "@/core/knowledge/model";
import {
  VOICES,
  type SpeechInputProvider,
  type SpeechOutputProvider,
} from "@/core/voice/providers";

import { ElevenLabsSpeechOutput } from "./elevenlabs/speech";
import { FailoverSpeechOutput } from "./failover-speech";
import { OpenAIEmbeddingProvider } from "./openai/embeddings";
import { OpenAIProvider } from "./openai/provider";
import { OpenAISpeechInput, OpenAISpeechOutput } from "./openai/speech";
import { resolveProfiles } from "./profiles";

export { createLiveWebRtcSession } from "./openai/live";

let provider: AIProvider | undefined;
let embeddings: EmbeddingProvider | undefined;
let speechIn: SpeechInputProvider | undefined;
let speechOut: SpeechOutputProvider | undefined;

function apiKey(): string {
  const env = serverEnv();
  if (!env.OPENAI_API_KEY) {
    throw new AppError("AI_NOT_CONFIGURED", "Elise's AI is not configured yet (OPENAI_API_KEY)", {
      recovery: "configure",
    });
  }
  return env.OPENAI_API_KEY;
}

/** Resolves the configured AI provider. OpenAI is the first (and today only) implementation. */
export function getAIProvider(): AIProvider {
  if (provider) return provider;
  const env = serverEnv();
  provider = new OpenAIProvider({ apiKey: apiKey(), profiles: resolveProfiles(env) });
  return provider;
}

/** Embeddings for Knowledge. The model name is configuration, recorded on every chunk. */
export function getEmbeddingProvider(): EmbeddingProvider {
  embeddings ??= new OpenAIEmbeddingProvider(apiKey(), serverEnv().OPENAI_EMBEDDING_MODEL);
  return embeddings;
}

/** Speech-to-text for voice turns (ADR-014). */
export function getSpeechInputProvider(): SpeechInputProvider {
  speechIn ??= new OpenAISpeechInput(apiKey(), serverEnv().OPENAI_TRANSCRIBE_MODEL);
  return speechIn;
}

/**
 * Text-to-speech for spoken replies (ADR-014, ADR-030). SPEECH_PROVIDER=elevenlabs (with its
 * key and voice) speaks through ElevenLabs, failing over to the current provider per segment;
 * anything else keeps the current provider. Reversible with one variable.
 */
export function getSpeechOutputProvider(): SpeechOutputProvider {
  if (speechOut) return speechOut;
  const env = serverEnv();
  const openai = new OpenAISpeechOutput(apiKey(), env.OPENAI_TTS_MODEL);
  const voices = elevenVoices();
  speechOut =
    env.SPEECH_PROVIDER === "elevenlabs" && env.ELEVENLABS_API_KEY && Object.keys(voices).length
      ? new FailoverSpeechOutput(
          new ElevenLabsSpeechOutput(
            env.ELEVENLABS_API_KEY,
            env.ELEVENLABS_MODEL_ID,
            voices,
            ELISE_VOICE_SETTINGS,
          ),
          openai,
          () => VOICES[0],
        )
      : openai;
  return speechOut;
}

/** Curated ELISE profiles → configured ElevenLabs voice ids (server-only). */
export function elevenVoices(): Record<string, string> {
  const env = serverEnv();
  return Object.fromEntries(
    [
      ["elise", env.ELEVENLABS_VOICE_ID],
      ["elise-alt", env.ELEVENLABS_VOICE_ID_ALT],
    ].filter((e): e is [string, string] => Boolean(e[1])),
  );
}

/**
 * ELISE's voice character in ElevenLabs terms, in one place (ADR-030): steady enough to be
 * recognisable across a long session, not flat; no exaggerated style.
 * ponytail: starting point from the docs' conversational guidance; retune with real A/B.
 */
export const ELISE_VOICE_SETTINGS = {
  stability: 0.55,
  similarity_boost: 0.75,
  style: 0,
  speed: 1,
} as const;
