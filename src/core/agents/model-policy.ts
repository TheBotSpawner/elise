import type { ModelTier, ReasoningEffort } from "./ai-provider";

/**
 * Which AI profile and how much deliberation each kind of work gets (ADR-019, ADR-025). One
 * table instead of magic values at call sites. Profiles (fast / standard / deep / background)
 * are resolved to models by configuration (AI_PROFILE_*), never named here.
 */
export interface ModelChoice {
  tier: ModelTier;
  /** Overrides the profile's own effort; omitted → the profile decides. */
  reasoning?: ReasoningEffort;
}

export const MODEL_POLICY = {
  /** Legacy chat routing (ELISE_AI_ROUTING=legacy): every typed turn on the standard profile. */
  chat: { tier: "standard" },
  /** Legacy: a spoken turn waits on every second of thinking. */
  voice_turn: { tier: "standard", reasoning: "low" },
  morning_brief: { tier: "standard" },
  study_concepts: { tier: "fast", reasoning: "low" },
  study_question: { tier: "fast", reasoning: "minimal" },
  study_evaluate: { tier: "fast", reasoning: "low" },
  recall_summary: { tier: "background" },
  finance_mapping: { tier: "background" },
  structured_mapping: { tier: "background" },
} as const satisfies Record<string, ModelChoice>;

export type ModelTask = keyof typeof MODEL_POLICY;

/**
 * Open-ended asks that deserve deliberate synthesis from the first call. Deterministic signals
 * only: classifying with a second model call would cost more latency than it saves.
 */
const DEEP_ASK =
  /\b(investig\w*|research\w*|compar\w*|analiz\w*|analy[sz]\w*|planific\w*|estrateg\w*|pros y contras|pros and cons|en profundidad|in depth|a fondo|detallad\w*|poneme al d[ií]a|ponerme al d[ií]a|catch me up|explic[aá]me|explain|por qu[eé]|why)\b/i;

/** Tools whose results need synthesis across sources: the answer after them is deep work. */
export const DEEP_SYNTHESIS_TOOLS: ReadonlySet<string> = new Set([
  "meeting.prepare",
  "web.research",
  "work.brief",
  "knowledge.compare",
]);

/**
 * Adaptive routing of an interactive turn: most requests (lookups, settings, tasks, routes,
 * Recall, a Knowledge question) run on the fast profile; explicitly open-ended asks start deep.
 * Escalation after deep-synthesis tools happens per model call (see escalateAfter).
 */
export function routeTurn(message: string): ModelChoice {
  if (message.length > 400 || DEEP_ASK.test(message)) return { tier: "deep" };
  return { tier: "fast" };
}

/** The model call after a deep-synthesis tool writes the answer with the deep profile. */
export function escalateAfter(toolNames: readonly string[]): ModelChoice | null {
  return toolNames.some((n) => DEEP_SYNTHESIS_TOOLS.has(n)) ? { tier: "deep" } : null;
}
