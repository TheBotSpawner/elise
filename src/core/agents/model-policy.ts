import type { ModelTier } from "./ai-provider";

/**
 * Which model tier and how much deliberation each kind of work gets (ADR-019; docs/12 §15-16).
 * One table instead of magic values at call sites. Interactive, bounded work (a settings change,
 * a task, a study question, a spoken turn) stays fast; open-ended synthesis gets the standard
 * tier. Model *names* stay configuration (OPENAI_MODEL / OPENAI_MODEL_FAST).
 */
export interface ModelChoice {
  tier: ModelTier;
  reasoning?: "minimal" | "low" | "medium";
}

export const MODEL_POLICY = {
  /** A typed turn: tools decide most of the work; the model keeps its default effort. */
  chat: { tier: "standard" },
  /** A spoken turn waits on every second of thinking: less deliberation, same tools. */
  voice_turn: { tier: "standard", reasoning: "low" },
  morning_brief: { tier: "standard" },
  study_concepts: { tier: "fast", reasoning: "low" },
  study_question: { tier: "fast", reasoning: "minimal" },
  study_evaluate: { tier: "fast", reasoning: "low" },
  recall_summary: { tier: "fast" },
  finance_mapping: { tier: "fast" },
  structured_mapping: { tier: "fast" },
} as const satisfies Record<string, ModelChoice>;

export type ModelTask = keyof typeof MODEL_POLICY;
