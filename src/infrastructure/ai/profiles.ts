import type { ModelTier, ReasoningEffort } from "@/core/agents/ai-provider";

/**
 * AI profiles (ADR-025): what each tier means in models, configured in one place. An env value
 * is `model[:effort[:serviceTier]]`, e.g. `gpt-6-luna:low` or `gpt-6-sol:medium:fast`.
 * Unset profiles use the benchmarked defaults below (docs/performance). The previous setup is
 * one configuration away (AI_PROFILE_STANDARD=gpt-5-mini, ELISE_AI_ROUTING=legacy…), so OLD and
 * OPTIMIZED can be compared without code changes.
 */
export interface AIProfile {
  model: string;
  /** Null: the model's own default. */
  reasoning: ReasoningEffort | null;
  /** "fast" (priority processing), "flex", or null for the default tier. */
  serviceTier: "fast" | "priority" | "flex" | null;
}

const EFFORTS = new Set<ReasoningEffort>(["none", "minimal", "low", "medium", "high"]);
const SERVICE_TIERS = new Set(["fast", "priority", "flex"]);

export function parseProfile(value: string | undefined, fallback: AIProfile): AIProfile {
  if (!value?.trim()) return fallback;
  const [model, effort, tier] = value
    .trim()
    .split(":")
    .map((x) => x.trim());
  return {
    model: model || fallback.model,
    reasoning:
      effort && EFFORTS.has(effort as ReasoningEffort) ? (effort as ReasoningEffort) : null,
    serviceTier: tier && SERVICE_TIERS.has(tier) ? (tier as AIProfile["serviceTier"]) : null,
  };
}

/**
 * Benchmarked defaults (2026-10-02, docs/performance): GPT-6 Luna at low effort keeps ELISE's
 * routing and answers at the quality bar for everyday turns at ~half the latency and ~⅓ the
 * cost of the previous gpt-5-mini setup; synthesis after multi-source tools gets medium effort.
 * Fast mode (priority processing) is off: it doubled cost with no measurable gain.
 */
export const DEFAULT_PROFILES: Record<ModelTier, AIProfile> = {
  fast: { model: "gpt-6-luna", reasoning: "low", serviceTier: null },
  standard: { model: "gpt-6-luna", reasoning: "low", serviceTier: null },
  deep: { model: "gpt-6-luna", reasoning: "medium", serviceTier: null },
  background: { model: "gpt-6-luna", reasoning: "low", serviceTier: null },
};

export function resolveProfiles(env: {
  AI_PROFILE_FAST?: string;
  AI_PROFILE_STANDARD?: string;
  AI_PROFILE_DEEP?: string;
  AI_PROFILE_BACKGROUND?: string;
}): Record<ModelTier, AIProfile> {
  return {
    fast: parseProfile(env.AI_PROFILE_FAST, DEFAULT_PROFILES.fast),
    standard: parseProfile(env.AI_PROFILE_STANDARD, DEFAULT_PROFILES.standard),
    deep: parseProfile(env.AI_PROFILE_DEEP, DEFAULT_PROFILES.deep),
    background: parseProfile(env.AI_PROFILE_BACKGROUND, DEFAULT_PROFILES.background),
  };
}

/**
 * The effort a model actually accepts (verified 2026-10): GPT-6 Luna/Sol take none…high;
 * GPT-6 Astra and GPT-6.1 Sol have no "none"; the GPT-5 family has "minimal" instead of
 * "none"; non-reasoning models take no effort at all.
 */
export function effortFor(model: string, effort: ReasoningEffort | null): ReasoningEffort | null {
  if (!effort) return null;
  if (!/^(gpt-[56]|o\d)/.test(model)) return null;
  const gpt6 = /^gpt-6/.test(model) || /^gpt-5\.6/.test(model);
  if (gpt6) {
    const noNone = /^gpt-6-astra|^gpt-6\.1/.test(model);
    if (effort === "minimal") return noNone ? "low" : "none";
    if (effort === "none" && noNone) return "low";
    return effort;
  }
  return effort === "none" ? "minimal" : effort;
}
