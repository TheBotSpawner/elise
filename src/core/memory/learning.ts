import {
  EXTRACTION_INSTRUCTIONS,
  extractionInput,
  parseCandidates,
  validateCandidate,
  type LearningTurn,
  type SkipReason,
} from "./extraction";
import type { MemoryChange, RememberInput } from "./model";

/**
 * One learning run over one interaction (ADR-107):
 *
 * consent → claim the interaction → its new turns since the last run (and since consent) →
 * batch rule → price known? → reserve budget → the model proposes → consent still on? →
 * the gate decides each candidate → not forgotten? → remember → settle the real cost →
 * advance the watermark.
 *
 * Every dependency is a port, so the rules are tested without a database or a model.
 * Idempotent: the watermark only moves after a run, a run holds a claim on its interaction,
 * and a budget reservation is keyed by the turns it covers.
 */
export interface LearningPorts {
  /** Memory on, learning opted in, rollout flag on; `since` is when they consented. */
  state(): Promise<{ on: boolean; since: string | null }>;
  /** Claims the interaction for this run; null when another run holds it or it's gone. */
  claim(): Promise<{ through: string | null } | null>;
  /** Ends the run: moves the watermark (or keeps it) and drops the claim. */
  release(through: string | null): Promise<void>;
  /** Turns after `after`: a few earlier ones marked context, then the new ones. */
  turns(after: string | null): Promise<LearningTurn[]>;
  /** USD for one call over this many characters, or null when the model has no known price. */
  estimate(chars: number): number | null;
  reserve(usd: number, jobRef: string): Promise<string | null>;
  settle(reservation: string, usd: number | null): Promise<void>;
  extract(instructions: string, input: string): Promise<{ text: string; usd: number | null }>;
  suppressed(key: string, value: string): Promise<boolean>;
  remember(input: RememberInput): Promise<MemoryChange["kind"] | "full">;
  now(): number;
  log(event: string, fields: Record<string, unknown>): void;
}

export type LearningStatus =
  | "off"
  | "busy"
  | "nothing_new"
  | "waiting"
  | "unpriced"
  | "over_budget"
  | "failed"
  | "unreadable"
  | "stopped"
  | "done";

export interface LearningOutcome {
  status: LearningStatus;
  saved: number;
  confirmed: number;
  skipped: Partial<Record<SkipReason | "suppressed" | "kept" | "full", number>>;
}

/** Learn after this many new turns from the person, or once the conversation went quiet. */
export const LEARNING_BATCH = { userTurns: 3, quietMs: 10 * 60_000, maxNewTurns: 40 } as const;

export async function learnFromInteraction(
  ports: LearningPorts,
  opts: { force?: boolean } = {},
): Promise<LearningOutcome> {
  const outcome: LearningOutcome = { status: "off", saved: 0, confirmed: 0, skipped: {} };
  const state = await ports.state();
  if (!state.on || !state.since) return outcome;
  const claim = await ports.claim();
  if (!claim) return { ...outcome, status: "busy" };
  let through = claim.through;
  try {
    // Never before consent: no backfill of older conversations.
    const after = !through || through < state.since ? state.since : through;
    const turns = await ports.turns(after);
    const fresh = turns.filter((t) => !t.context);
    const own = fresh.filter((t) => t.role === "user");
    const last = fresh.at(-1)?.at ?? null;
    if (!own.length) {
      if (last) through = last;
      return { ...outcome, status: "nothing_new" };
    }
    const quiet = last !== null && ports.now() - Date.parse(last) >= LEARNING_BATCH.quietMs;
    if (!opts.force && own.length < LEARNING_BATCH.userTurns && !quiet)
      return { ...outcome, status: "waiting" };

    const input = extractionInput(turns);
    const usd = ports.estimate(EXTRACTION_INSTRUCTIONS.length + input.length);
    // Without a known price the cost can't be bounded: optional learning fails closed.
    if (usd === null) return { ...outcome, status: "unpriced" };
    const reservation = await ports.reserve(usd, `${fresh[0]!.id}:${last}`);
    if (!reservation) return { ...outcome, status: "over_budget" };

    let reply: { text: string; usd: number | null };
    try {
      reply = await ports.extract(EXTRACTION_INSTRUCTIONS, input);
    } catch (error) {
      // The provider may have charged: count the estimate, keep the turns for a later run.
      await ports.settle(reservation, usd);
      ports.log("memory.learn_failed", { reason: "provider" });
      throw error;
    }
    await ports.settle(reservation, reply.usd ?? usd);
    const candidates = parseCandidates(reply.text);
    if (!candidates) {
      // Paid for and unreadable: move on rather than pay again for the same turns.
      through = last;
      return { ...outcome, status: "unreadable" };
    }
    // Turned off while the model worked: nothing it proposed is kept.
    if (!(await ports.state()).on) return { ...outcome, status: "stopped" };

    for (const c of candidates) {
      const v = validateCandidate(c, turns);
      if (!v.ok) {
        outcome.skipped[v.reason] = (outcome.skipped[v.reason] ?? 0) + 1;
        continue;
      }
      if (await ports.suppressed(v.key, v.value)) {
        outcome.skipped.suppressed = (outcome.skipped.suppressed ?? 0) + 1;
        continue;
      }
      // The source is this interaction (the port knows its id); turns stay in Recall.
      const change = await ports.remember({
        key: v.key,
        value: v.value,
        category: v.category,
        provenance: v.provenance,
        certainty: v.certainty,
        source: null,
        learned: true,
      });
      if (change === "insert" || change === "replace") outcome.saved++;
      else if (change === "confirm") outcome.confirmed++;
      else outcome.skipped[change] = (outcome.skipped[change] ?? 0) + 1;
    }
    through = last;
    return { ...outcome, status: "done" };
  } finally {
    await ports.release(through);
  }
}
