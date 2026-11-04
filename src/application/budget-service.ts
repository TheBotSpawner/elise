import "server-only";

import {
  budgetMode,
  modalityOf,
  RESERVATION_TTL_SECONDS,
  RESERVE_MICRO,
  VOICE_LEASE_MS,
  warnLevel,
  type BudgetFailure,
} from "@/core/budget/policy";
import { AppError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";
import { withUsageScope, type UsageScope } from "@/infrastructure/observability/usage";
import { rateLimit } from "@/infrastructure/rate-limit";
import { createAdminClient } from "@/infrastructure/supabase/admin";

import type { AuthContext } from "./auth-context";

/**
 * The budget gate (ADR-138): one decision before an interaction spends, taken atomically by the
 * database. Observe does nothing here, shadow decides and records without blocking, enforced
 * refuses. Identity comes from the caller's verified context, never from a request's body.
 */

export interface Clearance {
  scope: UsageScope;
  release: () => void;
}

interface Decision {
  reservation_id: string;
  allowed: boolean;
  reason: string | null;
}

export type Gate = (args: {
  key: string;
  user: string | null;
  workspace: string;
  modality: string;
  amount: number;
  enforce: boolean;
}) => Promise<Decision>;

const databaseGate: Gate = async (a) => {
  const { data, error } = await createAdminClient().rpc("reserve_budget", {
    p_key: a.key,
    p_user: a.user,
    p_workspace: a.workspace,
    p_modality: a.modality,
    p_amount: a.amount,
    p_enforce: a.enforce,
    p_ttl_seconds: RESERVATION_TTL_SECONDS,
  });
  const decision = data?.[0];
  if (error || !decision) throw new Error(error?.code ?? "no_decision");
  return decision;
};

let gate: Gate = databaseGate;

/** Test seam. */
export function setBudgetGate(next: Gate | null) {
  gate = next ?? databaseGate;
  leases.clear();
}

const releaseReservation = (id: string) =>
  void createAdminClient()
    .rpc("release_budget", { p_reservation: id })
    .then(({ error }) => {
      // Not fatal: the reservation expires by itself.
      if (error) logger.warn("budget.release_failed", { code: error.code });
    });

/** ponytail: per instance; each instance asks the gate once per lease. */
const leases = new Map<string, number>();

const refused = (reason: string | null) =>
  new AppError("BUDGET_EXCEEDED", "Your usage allowance for now has run out", {
    details: { reason },
  });

async function requestSource(): Promise<UsageScope["source"]> {
  try {
    const { headers } = await import("next/headers");
    return (await headers()).get("x-elise-client") === "desktop" ? "desktop" : "web";
  } catch {
    return null;
  }
}

/** The gate itself failed. Never "anything goes": refuse, or a small allowance of plain chat. */
function whenGateFails(scope: UsageScope) {
  const policy = (process.env.ELISE_BUDGET_ON_ERROR ?? "deny") as BudgetFailure;
  if (policy === "degraded" && modalityOf(scope.feature) === "chat") {
    rateLimit(`budget.degraded:${scope.userId ?? scope.workspaceId}`, 5, 3_600_000);
    return;
  }
  throw new AppError("BUDGET_EXCEEDED", "This action isn't available right now", {
    details: { reason: "gate_failed" },
  });
}

/** Asks before spending; throws BUDGET_EXCEEDED when enforcing says no. */
export async function clearSpend(
  scope: UsageScope,
  key: string = crypto.randomUUID(),
): Promise<Clearance> {
  const mode = budgetMode(process.env.ELISE_BUDGET_MODE, scope.workspaceId);
  const cleared: UsageScope = {
    ...scope,
    source: scope.source ?? (await requestSource()),
    cleared: true,
  };
  const done = { scope: cleared, release: () => undefined };
  if (mode === "observe") return done;

  const modality = modalityOf(scope.feature);
  // Single voice calls (a sentence, a transcription) are cents at most: answered once per lease.
  const single = scope.feature === "voice";
  const lease = `${scope.userId ?? scope.workspaceId}:${scope.feature}`;
  if (single && (leases.get(lease) ?? 0) > Date.now()) return done;

  const ask = gate({
    key,
    user: scope.userId ?? null,
    workspace: scope.workspaceId,
    modality,
    amount: RESERVE_MICRO[modality],
    enforce: mode === "enforced",
  });

  if (mode === "shadow") {
    if (single) leases.set(lease, Date.now() + VOICE_LEASE_MS);
    // Off the request's path: a shadow gate can't slow or break anything.
    void ask.then(
      (d) => d.reason && logger.info("budget.would_deny", { reason: d.reason, modality }),
      () => logger.warn("budget.gate_failed", { mode }),
    );
    return done;
  }

  let decision: Decision;
  try {
    decision = await ask;
  } catch {
    logger.error("budget.gate_failed", { mode, modality });
    whenGateFails(scope);
    return done;
  }
  if (!decision.allowed) {
    logger.info("budget.denied", { reason: decision.reason, modality });
    throw refused(decision.reason);
  }
  const id = decision.reservation_id;
  if (single) {
    leases.set(lease, Date.now() + VOICE_LEASE_MS);
    releaseReservation(id);
    return done;
  }
  let open = true;
  return {
    scope: { ...cleared, reservationId: id },
    release: () => {
      if (open) releaseReservation(id);
      open = false;
    },
  };
}

/** A bounded piece of work that must not start without clearance. */
export async function withSpend<T>(scope: UsageScope, fn: () => Promise<T>): Promise<T> {
  const spend = await clearSpend(scope);
  try {
    return await withUsageScope(spend.scope, fn);
  } finally {
    spend.release();
  }
}

/**
 * Work that isn't only spending: a job, or a suggestion with a plain fallback. Refused, it still
 * runs, in a scope the adapters reject: every paid call fails and the work ends through its usual
 * error path, recorded, instead of a job left hanging or retrying into spending.
 */
export async function withBackgroundSpend<T>(scope: UsageScope, fn: () => Promise<T>): Promise<T> {
  const spend = await clearSpend(scope).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "BUDGET_EXCEEDED")
      return { scope, release: () => undefined };
    throw error;
  });
  try {
    return await withUsageScope(spend.scope, fn);
  } finally {
    spend.release();
  }
}

/** The scope of a background task: no person, so it answers to the workspace's owner. */
export const job = (workspaceId: string, feature: string): UsageScope => ({
  workspaceId,
  feature,
  source: "job",
});

export interface BudgetNotice {
  /** 70, 90 or 100: the warning reached. Never an amount. */
  level: 70 | 90 | 100 | null;
  /** When a trial ends. */
  endsAt: string | null;
}

/** What Settings tells a person with a plan. Null with no plan, or if it can't be read. */
export async function budgetNotice(auth: AuthContext): Promise<BudgetNotice | null> {
  const { data, error } = await createAdminClient().rpc("budget_status", { p_user: auth.userId });
  const row = data?.[0];
  if (error || !row) return null;
  return { level: warnLevel(row.used_percent), endsAt: row.ends_at };
}
