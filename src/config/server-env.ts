import "server-only";

import { z } from "zod";

const serverEnvSchema = z.object({
  ELISE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Model names are configuration, never feature code (docs/architecture/12 §16).
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
  OPENAI_MODEL_FAST: z.string().min(1).default("gpt-5-nano"),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  TRIGGER_SECRET_KEY: z.string().min(1).optional(),
  CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Validated server configuration. Missing optional secrets disable features, never the build. */
export function serverEnv(): ServerEnv {
  if (!cached) {
    const blankToUndefined = Object.fromEntries(
      Object.keys(serverEnvSchema.shape).map((key) => [key, process.env[key] || undefined]),
    );
    cached = serverEnvSchema.parse(blankToUndefined);
  }
  return cached;
}
