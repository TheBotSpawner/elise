import "server-only";

import { serverEnv } from "@/config/server-env";
import type { AIProvider } from "@/core/agents/ai-provider";
import { AppError } from "@/core/errors";
import type { EmbeddingProvider } from "@/core/knowledge/model";
import type { SpeechInputProvider, SpeechOutputProvider } from "@/core/voice/providers";

import { OpenAIEmbeddingProvider } from "./openai/embeddings";
import { OpenAIProvider } from "./openai/provider";
import { OpenAISpeechInput, OpenAISpeechOutput } from "./openai/speech";

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
  provider = new OpenAIProvider({
    apiKey: apiKey(),
    models: { standard: env.OPENAI_MODEL, fast: env.OPENAI_MODEL_FAST },
  });
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

/** Text-to-speech for spoken replies (ADR-014). */
export function getSpeechOutputProvider(): SpeechOutputProvider {
  speechOut ??= new OpenAISpeechOutput(apiKey(), serverEnv().OPENAI_TTS_MODEL);
  return speechOut;
}
