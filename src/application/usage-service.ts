import "server-only";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import type { AuthContext } from "./auth-context";

/** Internal pages are for the people listed in ELISE_ADMIN_EMAILS — never other users. */
export function isAdmin(auth: AuthContext): boolean {
  const allowed = (serverEnv().ELISE_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(auth.email && allowed.includes(auth.email.toLowerCase()));
}

export interface UsageRow {
  feature: string;
  operation: string;
  model: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  units: number;
  unit: string | null;
  costUsd: number;
  avgLatencyMs: number | null;
}

export interface UsageSummary {
  days: number;
  rows: UsageRow[];
  totals: { calls: number; costUsd: number; workspaces: number };
  byDay: { day: string; calls: number; costUsd: number }[];
  jobs: { kind: string; status: string; count: number }[];
  truncated: boolean;
}

const MAX_ROWS = 20_000;

/**
 * Aggregated usage across all workspaces for the internal page (ADR-019). Metadata only: no
 * prompts, content or user identities leave this function — just counts per feature/model.
 */
export async function usageSummary(auth: AuthContext, days = 30): Promise<UsageSummary> {
  if (!isAdmin(auth)) throw new AppError("PERMISSION_DENIED", "Not available");
  const admin = createAdminClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [{ data: events }, { data: runs }, { data: syncs }] = await Promise.all([
    admin
      .from("usage_events")
      .select(
        "workspace_id, feature, operation, model, input_tokens, output_tokens, cached_tokens, units, unit, latency_ms, estimated_cost_usd, status, created_at",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS),
    admin.from("schedule_runs").select("status").gte("scheduled_for", since).limit(MAX_ROWS),
    admin.from("knowledge_sync_runs").select("status").gte("created_at", since).limit(MAX_ROWS),
  ]);

  const groups = new Map<string, UsageRow & { latencySum: number; latencyN: number }>();
  const byDay = new Map<string, { calls: number; costUsd: number }>();
  const workspaces = new Set<string>();
  for (const e of events ?? []) {
    workspaces.add(e.workspace_id);
    const key = `${e.feature}|${e.operation}|${e.model ?? ""}`;
    const g = groups.get(key) ?? {
      feature: e.feature,
      operation: e.operation,
      model: e.model ?? "—",
      calls: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      units: 0,
      unit: e.unit,
      costUsd: 0,
      avgLatencyMs: null,
      latencySum: 0,
      latencyN: 0,
    };
    g.calls++;
    if (e.status === "failed") g.failed++;
    g.inputTokens += e.input_tokens ?? 0;
    g.outputTokens += e.output_tokens ?? 0;
    g.cachedTokens += e.cached_tokens ?? 0;
    g.units += Number(e.units ?? 0);
    g.costUsd += Number(e.estimated_cost_usd ?? 0);
    if (e.latency_ms != null) {
      g.latencySum += e.latency_ms;
      g.latencyN++;
    }
    groups.set(key, g);
    const day = e.created_at.slice(0, 10);
    const d = byDay.get(day) ?? { calls: 0, costUsd: 0 };
    d.calls++;
    d.costUsd += Number(e.estimated_cost_usd ?? 0);
    byDay.set(day, d);
  }
  const rows = [...groups.values()]
    .map(({ latencySum, latencyN, ...row }) => ({
      ...row,
      avgLatencyMs: latencyN ? Math.round(latencySum / latencyN) : null,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  const count = (kind: string, list: { status: string }[] | null) =>
    Object.entries(
      (list ?? []).reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {}),
    ).map(([status, n]) => ({ kind, status, count: n }));

  return {
    days,
    rows,
    totals: {
      calls: rows.reduce((n, r) => n + r.calls, 0),
      costUsd: rows.reduce((n, r) => n + r.costUsd, 0),
      workspaces: workspaces.size,
    },
    byDay: [...byDay.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    jobs: [...count("schedule", runs), ...count("knowledge_sync", syncs)],
    truncated: (events?.length ?? 0) >= MAX_ROWS,
  };
}
