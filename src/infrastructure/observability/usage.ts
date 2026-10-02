import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { priceFor, UNIT_PRICES } from "@/config/pricing";

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
}

export interface UsageRecord {
  operation: "llm" | "embedding" | "transcription" | "speech" | "web_search" | "web_fetch";
  provider: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  units?: number | null;
  unit?: "seconds" | "characters" | "queries" | "pages" | null;
  latencyMs?: number | null;
  status?: "succeeded" | "failed";
}

const storage = new AsyncLocalStorage<UsageScope>();

/** Runs `fn` (and everything it starts, including a stream's start()) inside a usage scope. */
export function withUsageScope<T>(scope: UsageScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Narrows the current scope's feature (e.g. a meeting prep inside a chat turn). */
export function withUsageFeature<T>(feature: string, fn: () => T): T {
  const current = storage.getStore();
  return current ? storage.run({ ...current, feature }, fn) : fn();
}

export function estimateCost(r: UsageRecord): number | null {
  const price = priceFor(r.model);
  if (price && (r.inputTokens || r.outputTokens)) {
    const cached = r.cachedTokens ?? 0;
    const fresh = Math.max(0, (r.inputTokens ?? 0) - cached);
    return (
      (fresh * price.input +
        cached * (price.cached ?? price.input) +
        (r.outputTokens ?? 0) * price.output) /
      1_000_000
    );
  }
  const unitPrice =
    UNIT_PRICES[`${r.operation}:${r.unit}`] ?? UNIT_PRICES[`${r.operation}:${r.provider}`];
  return unitPrice !== undefined && r.units ? unitPrice * r.units : null;
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
      const { error } = await admin.from("usage_events").insert(row as never);
      if (error) logger.warn("usage.write_failed", { code: error.code });
    };
  } catch {
    sink = null;
  }
  return sink;
}

/** Test seam. */
export function setUsageSink(next: Sink | null) {
  sink = next;
}

/** Records one paid call. Never throws and never blocks the caller. */
export function recordUsage(r: UsageRecord): void {
  const scope = storage.getStore();
  const cost = estimateCost(r);
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
      }),
    )
    .catch(() => undefined);
}
