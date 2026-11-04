import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import {
  LONG_CONTEXT_TOKENS,
  PRICE_VERSION,
  priceFor,
  UNIT_PRICES,
  UNPRICED_BUDGET_MICRO,
  type TokenPrice,
} from "@/config/pricing";
import { budgetMode, modalityOf } from "@/core/budget/policy";
import { AppError } from "@/core/errors";

import { logger } from "./logger";

/**
 * AI and paid-API usage (ADR-019). Entry points (a chat turn, a voice request, a background
 * task) open a scope; every adapter that spends money records into it. Rows carry metadata
 * only — model, tokens, units, latency, an estimated cost — never prompts or content.
 */
export interface UsageScope {
  workspaceId: string;
  userId?: string | null;
  /** What the user was doing: chat, voice, study, morning_brief, knowledge_ingest, … */
  feature: string;
  aiRunId?: string | null;
  /** Where the request came from; a label for reports, never a permission. */
  source?: "web" | "desktop" | "job" | null;
  /** The budget gate let this scope spend (ADR-138). Adapters check it. */
  cleared?: boolean;
  reservationId?: string | null;
}

export interface UsageRecord {
  operation:
    "llm" | "embedding" | "transcription" | "speech" | "web_search" | "web_fetch" | "maps" | "ocr";
  provider: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  units?: number | null;
  unit?: "seconds" | "characters" | "queries" | "pages" | null;
  latencyMs?: number | null;
  /** cancelled: cut before the provider reported usage; its tokens are ELISE's own estimate. */
  status?: "succeeded" | "failed" | "cancelled";
  /** The provider's id for this call: the same call is never counted twice. */
  providerRequestId?: string | null;
}

const storage = new AsyncLocalStorage<UsageScope>();

/** Runs `fn` (and everything it starts, including a stream's start()) inside a usage scope. */
export function withUsageScope<T>(scope: UsageScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/**
 * Every adapter calls this before spending (ADR-138): the safety net behind the entry points. A
 * path nobody wired through the gate is logged in shadow and refused when enforcing, so a forgotten
 * route can't be an unlimited one.
 */
export function assertSpendCleared(operation: UsageRecord["operation"]): void {
  const scope = storage.getStore();
  if (scope?.cleared) return;
  const mode = budgetMode(process.env.ELISE_BUDGET_MODE, scope?.workspaceId ?? null);
  if (mode === "observe") return;
  logger.warn("budget.ungated", { operation, feature: scope?.feature ?? "unscoped" });
  if (mode === "enforced")
    throw new AppError("BUDGET_EXCEEDED", "This action isn't available right now");
}

/** Narrows the current scope's feature (e.g. a meeting prep inside a chat turn). */
export function withUsageFeature<T>(feature: string, fn: () => T): T {
  const current = storage.getStore();
  return current ? storage.run({ ...current, feature }, fn) : fn();
}

let configured: { raw: string | undefined; prices: Record<string, TokenPrice> } | null = null;

/**
 * A model's price: AI_MODEL_PRICES (configuration, verified by whoever deploys) first, then
 * the built-in list. Null when unknown — callers that must bound a cost then refuse to run.
 */
export function modelPrice(model: string | null | undefined): TokenPrice | null {
  if (!model) return null;
  // Read directly (declared and documented in server-env): metering must not depend on the
  // rest of the configuration being valid.
  const raw = process.env.AI_MODEL_PRICES?.trim() || undefined;
  if (!configured || configured.raw !== raw) {
    let prices: Record<string, TokenPrice> = {};
    try {
      const parsed = raw ? (JSON.parse(raw) as Record<string, Partial<TokenPrice>>) : {};
      prices = Object.fromEntries(
        Object.entries(parsed).filter(
          (e): e is [string, TokenPrice] =>
            typeof e[1]?.input === "number" &&
            typeof e[1]?.output === "number" &&
            e[1].input >= 0 &&
            e[1].output >= 0,
        ),
      );
    } catch {
      logger.warn("usage.prices_unreadable", {});
    }
    configured = { raw, prices };
  }
  const prices = configured.prices;
  const key = Object.keys(prices)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? prices[key]! : priceFor(model);
}

/** USD for a call of these tokens on this model, or null when the model has no price. */
export function tokenCost(
  model: string | null | undefined,
  tokens: { input: number; output: number; cached?: number; cacheWrite?: number },
): number | null {
  const price = modelPrice(model);
  if (!price) return null;
  const rates = tokens.input > LONG_CONTEXT_TOKENS && price.long ? price.long : price;
  const cached = tokens.cached ?? 0;
  const written = tokens.cacheWrite ?? 0;
  const fresh = Math.max(0, tokens.input - cached - written);
  return (
    (fresh * rates.input +
      cached * (rates.cached ?? rates.input) +
      written * (price.cacheWrite ?? rates.input) +
      tokens.output * rates.output) /
    1_000_000
  );
}

/** USD for this record: its tokens plus its units (a hosted search charges both), or null. */
export function estimateCost(r: UsageRecord): number | null {
  const hasTokens = Boolean(r.inputTokens || r.outputTokens);
  const tokens = hasTokens
    ? tokenCost(r.model, {
        input: r.inputTokens ?? 0,
        output: r.outputTokens ?? 0,
        cached: r.cachedTokens ?? 0,
        cacheWrite: r.cacheWriteTokens ?? 0,
      })
    : null;
  const unitPrice =
    UNIT_PRICES[`${r.operation}:${r.model}`] ?? UNIT_PRICES[`${r.operation}:${r.provider}`];
  const units = unitPrice !== undefined && r.units ? unitPrice * r.units : null;
  // Tokens that have no price leave the whole call unknown: half a cost isn't a cost.
  if (hasTokens && tokens === null) return null;
  return tokens === null && units === null ? null : (tokens ?? 0) + (units ?? 0);
}

/**
 * What an event says about money (ADR-138). A failed call was not billed. A succeeded one with no
 * price still counts against the budget, at a deliberately high stand-in.
 */
export function assess(r: UsageRecord) {
  const status = r.status ?? "succeeded";
  if (status === "failed") return { cost: 0, costStatus: "actual" as const, budgetMicro: 0 };
  const cost = estimateCost(r);
  if (cost === null)
    return {
      cost: null,
      costStatus: "unknown" as const,
      budgetMicro: UNPRICED_BUDGET_MICRO[r.operation] ?? 20_000,
    };
  return {
    cost,
    costStatus: status === "cancelled" ? ("estimated" as const) : ("actual" as const),
    budgetMicro: Math.ceil(cost * 1_000_000),
  };
}

type Sink = (row: Record<string, unknown>) => Promise<void>;
let sink: Sink | null | undefined;

/** Lazily bound so tests and scripts without Supabase still run; failures are only logged. */
async function defaultSink(): Promise<Sink | null> {
  if (sink !== undefined) return sink;
  try {
    const { createAdminClient } = await import("@/infrastructure/supabase/admin");
    const admin = createAdminClient();
    sink = async (row) => {
      const { error } = await admin
        .from("usage_events")
        .upsert(row as never, { onConflict: "idempotency_key", ignoreDuplicates: true });
      if (!error) return;
      // The database may lag this code (migration 070 not applied yet): usage still gets recorded.
      if (error.code === "PGRST204" || error.code === "42P10") {
        const { error: again } = await admin.from("usage_events").insert(legacyRow(row) as never);
        if (!again) return;
      }
      logger.warn("usage.write_failed", { code: error.code });
    };
  } catch {
    sink = null;
  }
  return sink;
}

const ADDED_IN_070 = [
  "source",
  "modality",
  "cache_write_tokens",
  "idempotency_key",
  "provider_request_id",
  "cost_status",
  "price_version",
  "budget_micro",
  "reservation_id",
];
const legacyRow = (row: Record<string, unknown>) => ({
  ...Object.fromEntries(Object.entries(row).filter(([k]) => !ADDED_IN_070.includes(k))),
  status: row.status === "cancelled" ? "failed" : row.status,
});

/** Test seam. */
export function setUsageSink(next: Sink | null) {
  sink = next;
}

/** Records one paid call. Never throws and never blocks the caller. */
export function recordUsage(r: UsageRecord): void {
  const scope = storage.getStore();
  const { cost, costStatus, budgetMicro } = assess(r);
  logger.info("usage", {
    feature: scope?.feature ?? "unscoped",
    workspace_id: scope?.workspaceId,
    run_id: scope?.aiRunId,
    operation: r.operation,
    provider: r.provider,
    model: r.model,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cached_tokens: r.cachedTokens,
    reasoning_tokens: r.reasoningTokens,
    units: r.units,
    unit: r.unit,
    latency_ms: r.latencyMs,
    estimated_cost_usd: cost,
    cost_status: costStatus,
    status: r.status ?? "succeeded",
  });
  if (!scope) return;
  void defaultSink()
    .then((write) =>
      write?.({
        workspace_id: scope.workspaceId,
        user_id: scope.userId ?? null,
        feature: scope.feature.slice(0, 40),
        operation: r.operation,
        provider: r.provider.slice(0, 40),
        model: r.model?.slice(0, 80) ?? null,
        input_tokens: r.inputTokens ?? null,
        output_tokens: r.outputTokens ?? null,
        cached_tokens: r.cachedTokens ?? null,
        reasoning_tokens: r.reasoningTokens ?? null,
        units: r.units ?? null,
        unit: r.unit ?? null,
        latency_ms: r.latencyMs != null ? Math.round(r.latencyMs) : null,
        estimated_cost_usd: cost,
        status: r.status ?? "succeeded",
        ai_run_id: scope.aiRunId ?? null,
        source: scope.source ?? null,
        modality: modalityOf(scope.feature),
        cache_write_tokens: r.cacheWriteTokens ?? null,
        idempotency_key: r.providerRequestId
          ? `${r.provider}:${r.providerRequestId}`.slice(0, 200)
          : null,
        provider_request_id: r.providerRequestId?.slice(0, 200) ?? null,
        cost_status: costStatus,
        price_version: PRICE_VERSION,
        budget_micro: budgetMicro,
        reservation_id: scope.reservationId ?? null,
      }),
    )
    .catch(() => undefined);
}
