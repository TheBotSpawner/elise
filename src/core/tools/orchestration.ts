import type { ToolCallOutcome } from "../agents/executor";
import type { ToolDisplay, ToolRunEnv } from "../agents/tools";
import type { SurfaceDraft, WorkspaceOp } from "../workspace/model";

/**
 * Shared pieces of ELISE's orchestrations (meeting prep, work brief): nested reads through the
 * executor, each source as an activity step whose failure is reported — never thrown — and
 * Surfaces presented as each source returns.
 */

/** A source that couldn't be used becomes a gap, never a failed orchestration. */
export interface StepResult<T> {
  value: T | null;
  problem: string | null;
  status: "ok" | "unavailable" | "failed";
}

const UNAVAILABLE = ["CAPABILITY_UNAVAILABLE", "AUTH_ERROR", "AUTH_EXPIRED", "PERMISSION_DENIED"];

export async function runStep<T>(
  env: ToolRunEnv,
  source: string,
  tool: string,
  run: () => Promise<{ value: T; outcome: ToolCallOutcome | null }>,
  /** Tools that report their own activity (web.*) get no second line. */
  selfReporting = false,
): Promise<StepResult<T>> {
  const id = `${source}:${crypto.randomUUID().slice(0, 8)}`;
  const workspace = selfReporting ? undefined : env.ctx.workspace;
  workspace?.activity({ id, tool, status: "running" });
  try {
    const { value, outcome } = await run();
    if (outcome && outcome.status !== "succeeded") {
      const unavailable =
        outcome.status === "failed" ? UNAVAILABLE.includes(outcome.error.code) : true;
      workspace?.activity({ id, tool, status: unavailable ? "unavailable" : "failed" });
      return {
        value: null,
        status: unavailable ? "unavailable" : "failed",
        problem: `${source}: ${outcome.status === "failed" ? (unavailable ? "not connected or not allowed" : outcome.error.code) : outcome.status}`,
      };
    }
    workspace?.activity({ id, tool, status: "done" });
    return { value, problem: null, status: "ok" };
  } catch {
    workspace?.activity({ id, tool, status: "failed" });
    return { value: null, problem: `${source}: failed`, status: "failed" };
  }
}

export function invoke(env: ToolRunEnv, name: string, args: unknown): Promise<ToolCallOutcome> {
  if (!env.invoke) throw new Error("Nested reads are unavailable");
  return env.invoke(name, args);
}

export const displayOf = <K extends ToolDisplay["kind"]>(o: ToolCallOutcome, kind: K) =>
  o.status === "succeeded" && o.display?.kind === kind
    ? (o.display as Extract<ToolDisplay, { kind: K }>)
    : null;

/** Presents (or updates) Surfaces in the interaction's workspace, if it has one. */
export function present(env: ToolRunEnv, drafts: (SurfaceDraft | null)[]) {
  const at = new Date().toISOString();
  const ops: WorkspaceOp[] = drafts
    .filter((d): d is SurfaceDraft => d !== null)
    .map((surface) => ({ op: "present", surface, at }));
  if (ops.length) env.ctx.workspace?.apply(ops);
}

export const clip = (s: string | null | undefined, n: number) =>
  !s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s;
