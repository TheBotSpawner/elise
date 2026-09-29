import "server-only";

import { serverEnv } from "@/config/server-env";
import type { AIProvider } from "@/core/agents/ai-provider";
import { AppError } from "@/core/errors";

import { OpenAIProvider } from "./openai/provider";

let provider: AIProvider | undefined;

/** Resolves the configured AI provider. OpenAI is the first (and today only) implementation. */
export function getAIProvider(): AIProvider {
  if (provider) return provider;
  const env = serverEnv();
  if (!env.OPENAI_API_KEY) {
    throw new AppError("AI_NOT_CONFIGURED", "Elise's AI is not configured yet (OPENAI_API_KEY)", {
      recovery: "configure",
    });
  }
  provider = new OpenAIProvider({
    apiKey: env.OPENAI_API_KEY,
    models: { standard: env.OPENAI_MODEL, fast: env.OPENAI_MODEL_FAST },
  });
  return provider;
}
