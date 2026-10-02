import "server-only";

import { AppError } from "@/core/errors";
import { percentile, type TurnPerfSummary } from "@/core/perf";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import type { AuthContext } from "./auth-context";
import { isAdmin } from "./usage-service";

export interface PerfTurn {
  runId: string;
  at: string;
  status: string;
  perf: TurnPerfSummary;
}

export interface PerfGroup {
  intent: string;
  n: number;
  ttft: [number | null, number | null];
  firstSurface: [number | null, number | null];
  total: [number | null, number | null];
}

export interface LiveSessionPerf {
  at: string;
  connectMs: number | null;
  firstAudio: [number | null, number | null];
  interruptStop: number | null;
  delegations: number;
  usageSeconds: number | null;
}

/** GPT-Live sessions (ADR-026): numbers kept with each voice session, newest first. Admins only. */
export async function recentLivePerf(auth: AuthContext, limit = 20): Promise<LiveSessionPerf[]> {
  if (!isAdmin(auth)) throw new AppError("PERMISSION_DENIED", "Not available");
  const { data } = await createAdminClient()
    .from("interaction_sessions")
    .select("metadata, last_activity_at")
    .is("conversation_id", null)
    .not("metadata->live", "is", null)
    .order("last_activity_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((s) => {
    const live = ((s.metadata ?? {}) as { live?: Record<string, unknown> }).live ?? {};
    const audio = (live.firstAudioMs as number[] | undefined) ?? [];
    const stops = ((live.interruptStopMs as number[] | undefined) ?? []).filter((x) => x >= 0);
    return {
      at: s.last_activity_at,
      connectMs: (live.connectMs as number | undefined) ?? null,
      firstAudio: [percentile(audio, 50), percentile(audio, 90)],
      interruptStop: percentile(stops, 50),
      delegations: (live.delegations as number | undefined) ?? 0,
      usageSeconds: (live.usageSeconds as number | undefined) ?? null,
    };
  });
}

/**
 * Recent turn timings for the internal performance page (ADR-025). Numbers and names only —
 * the perf record never holds content. Admins (ELISE_ADMIN_EMAILS) only.
 */
export async function recentTurnPerf(
  auth: AuthContext,
  limit = 60,
): Promise<{ turns: PerfTurn[]; groups: PerfGroup[] }> {
  if (!isAdmin(auth)) throw new AppError("PERMISSION_DENIED", "Not available");
  const { data } = await createAdminClient()
    .from("ai_runs")
    .select("id, started_at, status, token_usage")
    .order("started_at", { ascending: false })
    .limit(limit * 2);
  const turns: PerfTurn[] = (data ?? [])
    .flatMap((r) => {
      const perf = (r.token_usage as { perf?: TurnPerfSummary } | null)?.perf;
      return perf ? [{ runId: r.id, at: r.started_at, status: r.status as string, perf }] : [];
    })
    .slice(0, limit);
  const byIntent = new Map<string, PerfTurn[]>();
  for (const t of turns) {
    const k = `${t.perf.intent ?? "general"} · ${t.perf.modality}`;
    byIntent.set(k, [...(byIntent.get(k) ?? []), t]);
  }
  const p = (xs: (number | null)[]): [number | null, number | null] => {
    const v = xs.filter((x): x is number => x != null);
    return [percentile(v, 50), percentile(v, 90)];
  };
  const groups = [...byIntent.entries()].map(([intent, list]) => ({
    intent,
    n: list.length,
    ttft: p(list.map((t) => t.perf.metrics.ttft)),
    firstSurface: p(list.map((t) => t.perf.metrics.firstSurface)),
    total: p(list.map((t) => t.perf.metrics.total)),
  }));
  return { turns, groups };
}
