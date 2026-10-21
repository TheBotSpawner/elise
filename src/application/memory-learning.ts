import "server-only";

import { serverEnv } from "@/config/server-env";
import type { AIProvider, AIUsage } from "@/core/agents/ai-provider";
import {
  CONSOLIDATION_OUTPUT,
  CONSOLIDATOR_VERSION,
  consolidateMemory,
  type ConsolidationPorts,
} from "@/core/memory/consolidation";
import { EXTRACTION_OUTPUT, type LearningTurn } from "@/core/memory/extraction";
import { LEARNING_BATCH, learnFromInteraction, type LearningPorts } from "@/core/memory/learning";
import { getAIProvider } from "@/infrastructure/ai";
import { resolveProfiles } from "@/infrastructure/ai/profiles";
import { logger } from "@/infrastructure/observability/logger";
import { tokenCost, withUsageScope } from "@/infrastructure/observability/usage";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import { learningState, memoryRepo } from "./memory-service";

/**
 * Background memory work (ADR-107), run by Trigger.dev (or in-process without it). The server's
 * client is used, every statement scoped to one person: consent, the budget and the gate are
 * checked here, never trusted from a payload.
 */

type Admin = ReturnType<typeof createAdminClient>;

/** Characters per token, rounded down: the estimate leans high, never low. */
const CHARS_PER_TOKEN = 3;
/** Output tokens a run is budgeted for (answers are short JSON; reconciled after the call). */
const BUDGETED_OUTPUT = { extract: 900, consolidate: 1800 } as const;
/** A claim older than this belongs to a run that died: the next one may take over. */
const CLAIM_MS = 10 * 60_000;

const backgroundModel = () => resolveProfiles(serverEnv()).background.model;

function estimator(kind: keyof typeof BUDGETED_OUTPUT) {
  return (chars: number) =>
    tokenCost(backgroundModel(), {
      input: Math.ceil(chars / CHARS_PER_TOKEN),
      output: BUDGETED_OUTPUT[kind],
    });
}

function budget(db: Admin, workspaceId: string, userId: string, kind: "extract" | "consolidate") {
  const env = serverEnv();
  return {
    async reserve(usd: number, jobRef: string) {
      const { data, error } = await db.rpc("memory_reserve_spend", {
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_kind: kind,
        p_job_ref: jobRef.slice(0, 200),
        p_estimate: Number(usd.toFixed(6)),
        p_user_cap: env.MEMORY_USER_MONTHLY_USD,
        p_workspace_cap: env.MEMORY_WORKSPACE_MONTHLY_USD ?? null,
      });
      if (error) {
        // Without the ledger there's no cap: fail closed.
        logger.warn("memory.budget_unavailable", { code: error.code });
        return null;
      }
      return data ?? null;
    },
    async settle(id: string, usd: number | null) {
      await db.rpc("memory_settle_spend", {
        p_id: id,
        p_actual: usd === null ? null : Number(usd.toFixed(6)),
      });
    },
  };
}

/** One structured call on the background profile; the answer's text and what it cost. */
async function structuredCall(
  ai: AIProvider,
  instructions: string,
  input: string,
  output: { name: string; schema: Record<string, unknown> },
): Promise<{ text: string; usd: number | null }> {
  let text = "";
  let usage: AIUsage | null = null;
  let model: string | null = null;
  for await (const e of ai.streamTurn({
    instructions,
    input: [{ type: "message", role: "user", content: input }],
    tools: [],
    tier: "background",
    output: output as never,
  })) {
    if (e.type === "text_delta") text += e.delta;
    if (e.type === "completed") {
      usage = e.usage;
      model = e.model;
    }
  }
  const usd = usage
    ? tokenCost(model ?? backgroundModel(), {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cached: usage.cachedTokens,
      })
    : null;
  return { text, usd };
}

// ── Learning from one interaction ────────────────────────────────────────────

const CONTEXT_TURNS = 4;

/**
 * Learns from the new turns of one interaction (a conversation or a voice session), if its
 * author opted in. Safe to call after every turn: it batches, claims, and only ever reads what
 * came after consent and after the last run.
 */
export async function learnFromSession(
  workspaceId: string,
  sessionId: string,
  opts: { force?: boolean } = {},
) {
  const db = createAdminClient();
  const { data: s } = await db
    .from("interaction_sessions")
    .select("id, user_id, conversation_id, status")
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!s || s.status !== "active") return null;
  const userId = s.user_id;
  const interaction = s.conversation_id ?? s.id;
  const repo = memoryRepo(db, workspaceId, userId);
  const money = budget(db, workspaceId, userId, "extract");
  const ai = getAIProvider();

  const turnsAfter = async (after: string | null, newer: boolean, limit: number) => {
    const at = s.conversation_id ? "created_at" : "occurred_at";
    let q = s.conversation_id
      ? db
          .from("messages")
          .select("id, role, content, at:created_at")
          .eq("conversation_id", s.conversation_id)
      : db
          .from("interaction_turns")
          .select("id, role, content, at:occurred_at")
          .eq("session_id", s.id);
    q = q.eq("workspace_id", workspaceId).in("role", ["user", "assistant"]);
    if (after) q = newer ? q.gt(at, after) : q.lte(at, after);
    const { data } = await q.order(at, { ascending: newer }).limit(limit);
    return (data ?? []) as unknown as {
      id: string;
      role: "user" | "assistant";
      content: string;
      at: string;
    }[];
  };

  const ports: LearningPorts = {
    state: () => learningState(db, workspaceId, userId),
    async claim() {
      const stale = new Date(Date.now() - CLAIM_MS).toISOString();
      const { data } = await db
        .from("interaction_sessions")
        .update({ memory_learning_at: new Date().toISOString() })
        .eq("id", s.id)
        .eq("workspace_id", workspaceId)
        .or(`memory_learning_at.is.null,memory_learning_at.lt."${stale}"`)
        .select("memory_learned_through")
        .maybeSingle();
      return data ? { through: data.memory_learned_through } : null;
    },
    async release(through) {
      await db
        .from("interaction_sessions")
        .update({
          memory_learning_at: null,
          ...(through ? { memory_learned_through: through } : {}),
        })
        .eq("id", s.id)
        .eq("workspace_id", workspaceId);
    },
    async turns(after) {
      const [fresh, earlier] = await Promise.all([
        turnsAfter(after, true, LEARNING_BATCH.maxNewTurns),
        after ? turnsAfter(after, false, CONTEXT_TURNS) : Promise.resolve([]),
      ]);
      const mark =
        (context: boolean) =>
        (t: (typeof fresh)[number]): LearningTurn => ({
          ...t,
          content: String(t.content ?? ""),
          context,
        });
      return [...earlier.reverse().map(mark(true)), ...fresh.map(mark(false))];
    },
    estimate: estimator("extract"),
    reserve: (usd, ref) => money.reserve(usd, `${interaction}:${ref}`),
    settle: money.settle,
    extract: (instructions, input) => structuredCall(ai, instructions, input, EXTRACTION_OUTPUT),
    suppressed: (key, value) => repo.suppressed(key, value),
    async remember(input) {
      const change = await repo.remember({ ...input, source: interaction });
      return change === "full" ? "full" : change.kind;
    },
    now: () => Date.now(),
    log: (event, fields) => logger.info(event, fields),
  };

  const outcome = await withUsageScope({ workspaceId, userId, feature: "memory_learning" }, () =>
    learnFromInteraction(ports, opts),
  );
  // Metadata only: counts and reasons, never what was said or learned.
  if (outcome.status !== "off" && outcome.status !== "waiting")
    logger.info("memory.learned", {
      workspace_id: workspaceId,
      status: outcome.status,
      saved: outcome.saved,
      confirmed: outcome.confirmed,
      ...Object.fromEntries(Object.entries(outcome.skipped).map(([k, v]) => [`skipped_${k}`, v])),
    });
  return outcome;
}

/** After a conversation was indexed: learn from it (cheap when its author didn't opt in). */
export async function learnFromConversation(workspaceId: string, conversationId: string) {
  const { data } = await createAdminClient()
    .from("interaction_sessions")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return data ? learnFromSession(workspaceId, data.id) : null;
}

/** People who opted in to learning (the only ones background memory work ever touches). */
async function learners(db: Admin, limit: number) {
  const { data } = await db
    .from("user_preferences")
    .select("workspace_id, user_id, value_json")
    .eq("key", "memory.learning")
    .limit(limit);
  return (data ?? []).filter((r) => (r.value_json as { on?: unknown } | null)?.on === true);
}

/**
 * Every 15 minutes: interactions of opted-in people that went quiet with turns not yet
 * learned from. Bounded; each run is idempotent.
 */
export async function memorySweep(limit = 50) {
  const env = serverEnv();
  if (env.MEMORY_LEARNING !== "on") return { processed: 0 };
  const db = createAdminClient();
  const people = await learners(db, 1000);
  const quiet = new Date(Date.now() - LEARNING_BATCH.quietMs).toISOString();
  let processed = 0;
  for (const p of people) {
    if (processed >= limit) break;
    const { data } = await db
      .from("interaction_sessions")
      .select("id, last_activity_at, memory_learned_through")
      .eq("workspace_id", p.workspace_id)
      .eq("user_id", p.user_id)
      .eq("status", "active")
      .lt("last_activity_at", quiet)
      .gte("last_activity_at", (p.value_json as { since: string }).since)
      .order("last_activity_at", { ascending: false })
      .limit(20);
    const due = (data ?? []).filter(
      (s) => !s.memory_learned_through || s.memory_learned_through < s.last_activity_at,
    );
    for (const s of due.slice(0, limit - processed)) {
      try {
        await learnFromSession(p.workspace_id, s.id);
      } catch (error) {
        logger.warn("memory.sweep_failed", {
          code: (error as { code?: string }).code ?? "UNKNOWN",
        });
      }
      processed++;
    }
  }
  return { processed };
}

// ── Consolidation and profile ────────────────────────────────────────────────

export async function consolidateUser(workspaceId: string, userId: string) {
  const db = createAdminClient();
  const repo = memoryRepo(db, workspaceId, userId);
  const money = budget(db, workspaceId, userId, "consolidate");
  const ai = getAIProvider();
  const ports: ConsolidationPorts = {
    on: async () => (await learningState(db, workspaceId, userId)).on,
    async facts() {
      const all = await repo.all();
      const since = Date.now() - 180 * 86_400_000;
      return {
        active: all.filter((f) => f.status === "active").slice(0, 150),
        history: all
          .filter((f) => f.status === "superseded" && Date.parse(f.updatedAt) >= since)
          .slice(0, 60),
      };
    },
    profileAt: async () => (await repo.profile()).at,
    estimate: estimator("consolidate"),
    reserve: (usd, ref) => money.reserve(usd, ref),
    settle: money.settle,
    consolidate: (instructions, input) =>
      structuredCall(ai, instructions, input, CONSOLIDATION_OUTPUT),
    async apply(plan, seen) {
      for (const id of plan.retire) {
        // Only inferences, and only if unchanged since they were read.
        await db
          .from("memory_facts")
          .update({ status: "superseded" })
          .eq("id", id)
          .eq("workspace_id", workspaceId)
          .eq("user_id", userId)
          .eq("provenance", "inferred")
          .eq("status", "active")
          .eq("updated_at", seen.get(id) ?? "");
      }
      await repo.saveProfile(plan.profile, `${backgroundModel()}@${CONSOLIDATOR_VERSION}`);
      // Anything forgotten meanwhile can't stay in the new profile.
      await repo.trimProfile();
    },
    log: (event, fields) => logger.info(event, fields),
  };
  const result = await withUsageScope(
    { workspaceId, userId, feature: "memory_consolidation" },
    () => consolidateMemory(ports),
  );
  logger.info("memory.consolidated", { workspace_id: workspaceId, ...result });
  return result;
}

/** Daily: consolidate the memory of opted-in people whose facts changed. Bounded. */
export async function consolidationSweep(limit = 200) {
  if (serverEnv().MEMORY_LEARNING !== "on") return { processed: 0 };
  const people = await learners(createAdminClient(), limit);
  let processed = 0;
  for (const p of people) {
    try {
      await consolidateUser(p.workspace_id, p.user_id);
    } catch (error) {
      logger.warn("memory.consolidate_failed", {
        code: (error as { code?: string }).code ?? "UNKNOWN",
      });
    }
    processed++;
  }
  return { processed };
}
