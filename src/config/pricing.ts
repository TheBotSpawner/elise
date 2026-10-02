/**
 * Cost ESTIMATES for usage visibility (ADR-019) — not billing. Values are USD list prices as
 * understood when written; verify against each provider's pricing page before relying on them.
 * An unknown model simply gets no estimate. Prefix match, longest first ("gpt-5-mini" before
 * "gpt-5").
 */
export interface TokenPrice {
  /** Per 1M input tokens. */
  input: number;
  /** Per 1M cached input tokens (defaults to input). */
  cached?: number;
  /** Per 1M output tokens. */
  output: number;
}

export const MODEL_PRICES: Record<string, TokenPrice> = {
  "gpt-5-nano": { input: 0.05, cached: 0.005, output: 0.4 },
  "gpt-5-mini": { input: 0.25, cached: 0.025, output: 2 },
  "gpt-5": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-4.1-mini": { input: 0.4, cached: 0.1, output: 1.6 },
  "gpt-4.1": { input: 2, cached: 0.5, output: 8 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

/** Non-token prices: per unit as recorded (seconds of audio, characters, queries). */
export const UNIT_PRICES: Record<string, number> = {
  // Speech: rough per-unit equivalents of the token prices.
  "speech:characters": 0.000015,
  "transcription:seconds": 0.0001,
  // Web search: a basic Tavily search is one credit; OpenAI hosted search is billed per call.
  "web_search:tavily": 0.008,
  "web_search:openai": 0.01,
  // Maps (ADR-023), per request (matrix: per element), list prices with the field masks used.
  "maps:google_maps.places.search": 0.035,
  "maps:google_maps.places.details": 0.02,
  "maps:google_maps.places.photo": 0.007,
  "maps:google_maps.geocode": 0.005,
  "maps:google_maps.routes": 0.01,
  "maps:google_maps.routes.matrix": 0.01,
};

export function priceFor(model: string | null | undefined): TokenPrice | null {
  if (!model) return null;
  const key = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? MODEL_PRICES[key]! : null;
}
