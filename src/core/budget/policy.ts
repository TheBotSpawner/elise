/**
 * Budgets (ADR-138), the pure rules. Limits and plans are data in the database; here is how a mode
 * is read, what a request holds while it runs and how much of a limit a person gets to hear about.
 * Amounts are integer micro-USD.
 */

export type BudgetMode = "observe" | "shadow" | "enforced";
export type Modality = "chat" | "voice" | "background";

/** What the failure of the gate itself does: never "anything goes". */
export type BudgetFailure = "deny" | "degraded";

/**
 * ELISE_BUDGET_MODE: `observe` (default), `shadow`, `enforced`, or `enforced:ws=<id>;<id>` to enforce
 * only there, with shadow everywhere else. Anything unreadable stays at observe: enforcing is a
 * decision someone writes down, never a typo's consequence.
 */
export function budgetMode(raw: string | undefined, workspaceId: string | null): BudgetMode {
  const value = raw?.trim() ?? "";
  if (value === "shadow" || value === "enforced") return value;
  if (value.startsWith("enforced:ws="))
    return workspaceId && value.slice(12).split(";").includes(workspaceId) ? "enforced" : "shadow";
  return "observe";
}

/**
 * What a request holds until it ends. Sized from recorded use (docs/engineering/38-cost-accounting.md):
 * a typical turn, with room; the final cost comes from the events, not from this.
 */
export const RESERVE_MICRO: Record<Modality, number> = {
  chat: 20_000,
  voice: 5_000,
  background: 20_000,
};

/** A held reservation a crash left behind goes back after this long. */
export const RESERVATION_TTL_SECONDS = 600;

/**
 * Voice speaks sentence by sentence: an answer from the gate is good for this long on this instance,
 * so no sentence waits for the database. Overshoot is bounded by what fits in it, cents at most.
 */
export const VOICE_LEASE_MS = 30_000;

export const modalityOf = (feature: string): Modality =>
  feature === "voice" || feature === "voice_turn"
    ? "voice"
    : feature === "chat"
      ? "chat"
      : "background";

export const WARN_LEVELS = [70, 90, 100] as const;

/** The highest level reached: all a person is told. Never amounts, never costs. */
export function warnLevel(usedPercent: number): (typeof WARN_LEVELS)[number] | null {
  return [...WARN_LEVELS].reverse().find((l) => usedPercent >= l) ?? null;
}
