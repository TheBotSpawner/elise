import type { Surface, WorkspaceState } from "./model";

/**
 * Surface lifecycle (ADR-029): the Canvas follows the application's real state, not the
 * model's memory. A successful write is a ResourceChange; every visible Surface that shows
 * that resource — directly (its ref) or as part of a collection (the read that produced it) —
 * is reconciled deterministically:
 *
 *   KEEP     unrelated, or a direct card the write itself re-presents in place
 *   UPDATE   re-run the Surface's own read and replace its payload in place (same id): counts,
 *            streaks and totals are recomputed by the domain, never patched item by item
 *   DISMISS  the resource is gone, or the refreshed collection is empty (nothing left to do)
 *
 * Pinned Surfaces stay but still update; a focused one updates in place, and leaves Focus
 * only when its resource is deleted. Pending approvals are never dismissed by this.
 */

export interface ResourceChange {
  /** The capability that wrote ("habits"). */
  capability: string;
  /** What changed ("habit", "task"); the capability when the tool names no target. */
  resourceType: string;
  resourceId: string | null;
  operation: "updated" | "deleted";
}

/** The read that produced a collection Surface, re-run to refresh it. */
export interface SurfaceQuery {
  tool: string;
  args: Record<string, unknown>;
}

export type LifecycleDecision = "keep" | "update" | "dismiss";

/** Which collections a capability's writes can change (habits feed linked goals' progress). */
const AFFECTS: Readonly<Record<string, readonly string[]>> = {
  habits: ["habits", "goals"],
  goals: ["goals"],
  tasks: ["tasks", "planning"],
  calendar: ["calendar", "planning"],
  finance: ["finance"],
  lists: ["lists"],
  notes: ["notes"],
  structured: ["structured"],
};

const DELETE = /^(delete|remove|archive|trash|discard)/i;

/** A successful write → what changed; reads and failures change nothing. */
export function changeOf(
  toolName: string,
  operation: { name: string; kind: "read" | "write" | "destructive" | string },
  outcome: { status: string; target?: { type: string; id: string } },
): ResourceChange | null {
  if (outcome.status !== "succeeded" || operation.kind === "read") return null;
  const capability = toolName.split(".")[0] ?? toolName;
  if (!AFFECTS[capability]) return null;
  return {
    capability,
    resourceType: outcome.target?.type ?? capability,
    resourceId: outcome.target?.id ?? null,
    operation: DELETE.test(operation.name) ? "deleted" : "updated",
  };
}

/** What a change means for one Surface. */
export function decide(surface: Surface, change: ResourceChange): LifecycleDecision {
  if (surface.type === "approval") return "keep";
  const direct =
    change.resourceId !== null &&
    surface.ref !== null &&
    surface.ref.id === change.resourceId &&
    surface.ref.resource === change.resourceType;
  if (direct && change.operation === "deleted") return "dismiss";
  const q = surface.query;
  if (!q) return "keep";
  const affected = AFFECTS[change.capability] ?? [];
  return affected.includes(q.tool.split(".")[0] ?? "") ? "update" : "keep";
}

/** The Surfaces a change touches, with what to do with each. */
export function affectedSurfaces(
  state: WorkspaceState,
  change: ResourceChange,
): { surface: Surface; decision: Exclude<LifecycleDecision, "keep"> }[] {
  return state.surfaces.flatMap((surface) => {
    const decision = decide(surface, change);
    return decision === "keep" ? [] : [{ surface, decision }];
  });
}

/**
 * A collection's identity is its query, not the call that ran it: reading "habits this week"
 * again (or refreshing it after a check-in) updates the same Surface instead of adding one.
 */
export function queryKey(tool: string, args: unknown): string {
  return `${tool}:${stable(args ?? {})}`;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${k}:${stable(x)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
