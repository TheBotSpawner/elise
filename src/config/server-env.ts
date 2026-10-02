import "server-only";

import { z } from "zod";

const serverEnvSchema = z.object({
  ELISE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Model names are configuration, never feature code (docs/architecture/12 §16).
  OPENAI_MODEL: z.string().min(1).default("gpt-5-mini"),
  OPENAI_MODEL_FAST: z.string().min(1).default("gpt-5-nano"),
  /** Knowledge embeddings (1536 dimensions are stored). Changing it requires a reindex. */
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  /** Voice (ADR-014): speech-to-text for completed utterances, and streamed text-to-speech. */
  OPENAI_TRANSCRIBE_MODEL: z.string().min(1).default("gpt-transcribe"),
  OPENAI_TTS_MODEL: z.string().min(1).default("gpt-4o-mini-tts"),
  /** Web (ADR-015): "openai" (hosted web search) or "tavily"; default: tavily if its key is set. */
  WEB_SEARCH_PROVIDER: z.enum(["openai", "tavily"]).optional(),
  OPENAI_WEB_SEARCH_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  TAVILY_API_KEY: z.string().min(1).optional(),
  /** Location (ADR-023): server key restricted to Places (New), Routes and Geocoding. */
  GOOGLE_MAPS_SERVER_API_KEY: z.string().min(1).optional(),
  NOTION_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  NOTION_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  TRIGGER_SECRET_KEY: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  /** 32 random bytes, base64. Encrypts OAuth credentials at rest. */
  ELISE_ENCRYPTION_KEY: z.string().min(1).optional(),
  ELISE_ENCRYPTION_KEY_PREVIOUS: z.string().min(1).optional(),
  CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(20),
  /** Comma-separated emails allowed to see internal pages (/admin/usage). Empty: nobody. */
  ELISE_ADMIN_EMAILS: z.string().optional(),
  /** Feature flag overrides (config/flags.ts). */
  ELISE_FLAGS: z.string().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;
let invalid: string[] = [];

/**
 * Validated server configuration. Missing optional secrets disable features, never the build.
 * A malformed value (a bad URL, an unknown provider name) disables only what it configures:
 * it is dropped with a warning instead of failing every request that reads configuration.
 */
export function serverEnv(): ServerEnv {
  if (!cached) {
    const raw: Record<string, string | undefined> = Object.fromEntries(
      Object.keys(serverEnvSchema.shape).map((key) => [key, process.env[key] || undefined]),
    );
    const first = serverEnvSchema.safeParse(raw);
    if (first.success) cached = first.data;
    else {
      invalid = [...new Set(first.error.issues.map((i) => String(i.path[0])))];
      for (const key of invalid) raw[key] = undefined;
      cached = serverEnvSchema.parse(raw);
      // Names only, never values.
      console.warn(JSON.stringify({ level: "warn", event: "env.invalid", keys: invalid }));
    }
  }
  return cached;
}

/** Variables that were set but malformed (for the health check; names only). */
export function invalidEnvKeys(): string[] {
  serverEnv();
  return invalid;
}
