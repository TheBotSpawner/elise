import "server-only";

import { z } from "zod";

const serverEnvSchema = z.object({
  ELISE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.url().optional(),
  /** Set by Vercel: "production" | "preview" | "development", and the production domain. */
  VERCEL_ENV: z.string().optional(),
  VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Model names are configuration, never feature code (docs/architecture/12 §16).

  /** AI profiles (ADR-025): "model[:effort[:serviceTier]]"; unset → benchmarked defaults. */
  AI_PROFILE_FAST: z.string().min(1).optional(),
  AI_PROFILE_STANDARD: z.string().min(1).optional(),
  AI_PROFILE_DEEP: z.string().min(1).optional(),
  AI_PROFILE_BACKGROUND: z.string().min(1).optional(),
  /** Chat routing: "adaptive" (fast/deep by request) or "legacy" (everything standard). */
  /** Voice runtime (ADR-026): "live" (GPT-Live + ELISE delegation) or "legacy" (STT → ELISE → TTS). */
  VOICE_RUNTIME: z.enum(["legacy", "live"]).default("legacy"),
  ELISE_AI_ROUTING: z.enum(["legacy", "adaptive"]).default("adaptive"),
  /** Tool exposure: "selected" (core + relevant groups, rest on demand) or "all". */
  ELISE_TOOL_SELECTION: z.enum(["all", "selected"]).default("selected"),
  /** Knowledge embeddings (1536 dimensions are stored). Changing it requires a reindex. */
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  /** Voice (ADR-014): speech-to-text for completed utterances, and streamed text-to-speech. */
  OPENAI_TRANSCRIBE_MODEL: z.string().min(1).default("gpt-transcribe"),
  OPENAI_TTS_MODEL: z.string().min(1).default("gpt-4o-mini-tts"),
  /** Spoken replies (ADR-030): "openai" (current) or "elevenlabs" (falls back to openai). */
  SPEECH_PROVIDER: z.enum(["openai", "elevenlabs"]).default("openai"),
  /** Server-only: never NEXT_PUBLIC_, never sent to the browser. */
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  /**
   * OCR (ADR-035): Google Document AI, Enterprise Document OCR processor — full resource name,
   * "projects/PROJECT/locations/us/processors/ID" — and the service account's JSON key (raw or
   * base64). Server only; unset = scanned pages are reported as unreadable instead of read.
   */
  GOOGLE_DOCUMENT_AI_PROCESSOR: z
    .string()
    .regex(/^projects\/[^/]+\/locations\/[a-z0-9-]+\/processors\/[^/]+$/)
    .optional(),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1).optional(),
  /** Curated voices (ADR-030): 1 = ELISE, 2 = Martín, 3 = Adriana. Server-only ids. */
  ELEVENLABS_VOICE_ID_1: z.string().min(1).optional(),
  ELEVENLABS_VOICE_ID_2: z.string().min(1).optional(),
  ELEVENLABS_VOICE_ID_3: z.string().min(1).optional(),
  /** Legacy single "ELISE" voice: used for ELISE only when ELEVENLABS_VOICE_ID_1 is unset. */
  ELEVENLABS_VOICE_ID: z.string().min(1).optional(),
  /** eleven_v4_turbo (Text to Dialogue WebSocket) or an HTTP model such as eleven_flash_v2_5. */
  ELEVENLABS_MODEL_ID: z.string().min(1).default("eleven_v4_turbo"),
  /** Web (ADR-015): "openai" (hosted web search) or "tavily"; default: tavily if its key is set. */
  WEB_SEARCH_PROVIDER: z.enum(["openai", "tavily"]).optional(),
  OPENAI_WEB_SEARCH_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  TAVILY_API_KEY: z.string().min(1).optional(),
  /**
   * Mercado Libre's official API (ADR-112): off unless "true" AND the application is approved.
   * The refresh token is ELISE's own application account's (never a user's), server-only.
   */
  MERCADOLIBRE_API_ENABLED: z.enum(["true", "false"]).default("false"),
  MERCADOLIBRE_CLIENT_ID: z.string().min(1).optional(),
  MERCADOLIBRE_CLIENT_SECRET: z.string().min(1).optional(),
  MERCADOLIBRE_REFRESH_TOKEN: z.string().min(1).optional(),
  /**
   * Prices from Google Shopping through SerpApi (ADR-116): off unless "true" AND a key is set.
   * Thumbnails only with SHOPPING_GOOGLE_SHOPPING_IMAGES=true (their licence is the stores').
   */
  SHOPPING_GOOGLE_SHOPPING_ENABLED: z.enum(["true", "false"]).default("false"),
  SHOPPING_GOOGLE_SHOPPING_IMAGES: z.enum(["true", "false"]).default("false"),
  SHOPPING_GOOGLE_SHOPPING_MONTHLY_LIMIT: z.coerce.number().int().min(0).default(200),
  SERPAPI_API_KEY: z.string().min(1).optional(),
  /** Location (ADR-023): server key restricted to Places (New), Routes and Geocoding. */
  GOOGLE_MAPS_SERVER_API_KEY: z.string().min(1).optional(),
  /** Weather (ADR-038): Open-Meteo commercial key; without it, the free non-commercial API. */
  OPEN_METEO_API_KEY: z.string().min(1).optional(),
  // ELISE Desktop release manifest (ADR-082): https URL (or a local path in development).
  ELISE_DESKTOP_MANIFEST_URL: z.string().min(3).optional(),
  // Which builds the download page offers: stable (default in production) or beta.
  ELISE_DESKTOP_DOWNLOAD_CHANNEL: z.enum(["stable", "beta"]).optional(),
  /** Market data (ADR-074): Financial Modeling Prep, server-only. Unset: no market tools. */
  FMP_API_KEY: z.string().min(1).optional(),
  /** Music (ADR-042): a Spotify app (Web API + Web Playback SDK). Redirect defaults to the app URL. */
  SPOTIFY_CLIENT_ID: z.string().min(1).optional(),
  SPOTIFY_CLIENT_SECRET: z.string().min(1).optional(),
  SPOTIFY_REDIRECT_URI: z.string().url().optional(),
  /** YouTube Data API v3 key (search only; playback is the official embedded player). */
  YOUTUBE_API_KEY: z.string().min(1).optional(),
  NOTION_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  NOTION_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  TRIGGER_SECRET_KEY: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  /** Microsoft Entra app (Outlook Mail, ADR-058). Tenant defaults to "common". */
  MICROSOFT_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  MICROSOFT_OAUTH_TENANT: z.string().min(1).optional(),
  /** Slack app (team messaging, ADR-062). Per-workspace tokens live encrypted in the database. */
  SLACK_CLIENT_ID: z.string().min(1).optional(),
  SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * "true" only for an unlisted, distributed Slack app, where Real-time Search is not allowed:
   * asks for the legacy `search:read` scope and searches with search.messages (ADR-062).
   */
  SLACK_LEGACY_SEARCH: z.enum(["true", "false"]).optional(),
  /** 32 random bytes, base64. Encrypts OAuth credentials at rest. */
  ELISE_ENCRYPTION_KEY: z.string().min(1).optional(),
  ELISE_ENCRYPTION_KEY_PREVIOUS: z.string().min(1).optional(),
  /**
   * Native memory (ADR-107). MEMORY_LEARNING is the rollout switch for learning from
   * conversations ("on" lets people opt in from Settings; off by default). Caps are hard USD
   * limits per calendar month (UTC) for background memory work: per person, and optionally per
   * workspace. MEMORY_FINGERPRINT_KEY keys the do-not-relearn hashes (defaults to a key derived
   * from ELISE_ENCRYPTION_KEY).
   */
  MEMORY_LEARNING: z.enum(["on", "off"]).default("off"),
  MEMORY_USER_MONTHLY_USD: z.coerce.number().min(0).max(100).default(0.5),
  MEMORY_WORKSPACE_MONTHLY_USD: z.coerce.number().min(0).max(10_000).optional(),
  MEMORY_FINGERPRINT_KEY: z.string().min(16).optional(),
  /**
   * Prices for models src/config/pricing.ts doesn't list, as JSON, per 1M tokens:
   * {"gpt-6-luna":{"input":0.1,"cached":0.01,"output":0.5}}. Verify them on the provider's
   * pricing page; a model without a price can't be budgeted, so memory learning won't run on it.
   */
  AI_MODEL_PRICES: z.string().min(2).optional(),
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
      Object.keys(serverEnvSchema.shape).map((key) => [key, process.env[key]?.trim() || undefined]),
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
