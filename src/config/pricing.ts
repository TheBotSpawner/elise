/**
 * The price list (ADR-138): gross list prices in USD, for assigning a cost to each call. Not
 * invoices, and not what a subscription's included credits really cost. Every event stores the cost
 * and PRICE_VERSION it was computed with, so changing a price never rewrites history: bump the
 * version with any change, after checking the source. Something absent here is `unknown`, never
 * guessed. A deploy can add models through AI_MODEL_PRICES.
 *
 * Verified 2026-11-04 on:
 *   OpenAI       https://developers.openai.com/api/docs/pricing
 *   ElevenLabs   https://elevenlabs.io/pricing/api
 *   Google Maps  https://developers.google.com/maps/billing-and-pricing/pricing (first paid tier;
 *                the monthly free caps aren't deducted, this is the gross cost)
 *   Tavily       https://docs.tavily.com/documentation/api-credits (pay as you go)
 *   Document AI  https://cloud.google.com/document-ai/pricing (first paid tier)
 */
export const PRICE_VERSION = "2026-11-04";

export interface TokenPrice {
  /** Per 1M input tokens. */
  input: number;
  /** Per 1M cached input tokens (defaults to input). */
  cached?: number;
  /** Per 1M input tokens written to the prompt cache, 30-minute retention (defaults to input). */
  cacheWrite?: number;
  /** Per 1M output tokens. */
  output: number;
  /** Above LONG_CONTEXT_TOKENS of input, the whole request is billed at these prices. */
  long?: { input: number; cached: number; output: number };
}

export const LONG_CONTEXT_TOKENS = 272_000;

/** Prefix match, longest first ("gpt-5-mini" before "gpt-5"). */
export const MODEL_PRICES: Record<string, TokenPrice> = {
  "gpt-6-luna": {
    input: 0.1,
    cached: 0.01,
    cacheWrite: 0.125,
    output: 0.5,
    long: { input: 0.2, cached: 0.02, output: 0.75 },
  },
  "gpt-6-sol": {
    input: 2,
    cached: 0.2,
    cacheWrite: 2.5,
    output: 10,
    long: { input: 4, cached: 0.4, output: 15 },
  },
  "gpt-5-nano": { input: 0.05, cached: 0.005, output: 0.4 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2 },
  "gpt-4.1-mini": { input: 0.4, cached: 0.1, output: 1.6 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
};

/**
 * Per unit as recorded, by `operation:model` or `operation:provider`. OpenAI's gpt-4o-mini-tts is
 * priced per audio token and its API doesn't report them: unknown on purpose, no per-character guess.
 */
export const UNIT_PRICES: Record<string, number> = {
  "speech:eleven_flash_v2_5": 0.04 / 1000,
  "speech:eleven_v4_turbo": 0.04 / 1000,
  "transcription:gpt-transcribe": 0.0045 / 60,
  // Per call or credit; a hosted search's tokens are added on top, at the model's prices.
  "web_search:tavily": 0.008,
  "web_search:openai": 0.01,
  "maps:google_maps.places.search": 0.04,
  "maps:google_maps.places.details": 0.025,
  "maps:google_maps.places.photo": 0.007,
  "maps:google_maps.geocode": 0.005,
  "maps:google_maps.routes": 0.01,
  "maps:google_maps.routes.matrix": 0.01,
  "ocr:google": 0.0015,
};

/**
 * What a succeeded call with no verified price counts against a budget, in micro-USD: deliberately
 * high, so a missing price can never mean free. It's not a cost and no report treats it as one.
 */
export const UNPRICED_BUDGET_MICRO: Record<string, number> = {
  llm: 20_000,
  embedding: 500,
  transcription: 2_000,
  speech: 2_000,
  web_search: 20_000,
  web_fetch: 0,
  maps: 40_000,
  ocr: 2_000,
};

export function priceFor(model: string | null | undefined): TokenPrice | null {
  if (!model) return null;
  const key = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? MODEL_PRICES[key]! : null;
}
