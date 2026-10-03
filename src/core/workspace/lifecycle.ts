import type { Surface, WorkspaceState } from "./model";
import type { SurfacePayloads } from "./registry";
import { planTemporal } from "./temporal-planner";
import { visualizationSpec, type VisualizationSpec } from "./visualization";

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

/** How much of a collection is read is not which data it is: pages of one dataset are one. */
const PAGING = new Set(["limit", "offset", "cursor", "page", "pageSize"]);

/** A read's dataset identity (ADR-031): its query without paging. */
export function datasetKey(tool: string, args: unknown): string {
  const rest = Object.fromEntries(
    Object.entries((args ?? {}) as Record<string, unknown>).filter(([k]) => !PAGING.has(k)),
  );
  return queryKey(tool, rest);
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

// ── Working set and representations (ADR-031) ────────────────────────────────

/**
 * What the user is working with, read from the Canvas itself (persisted with it):
 * - the last affected resource: the Surface a write most recently produced or changed;
 * - the active collection: the collection most recently shown, refreshed or focused.
 * "Mostramelo" resolves to the first, "mostralas / esas" to the second — the model expresses
 * the intent (ui.show), this code picks the Surface.
 */
export function lastAffected(state: WorkspaceState): Surface | null {
  return (
    state.surfaces
      .filter((s) => s.changedAt)
      .sort((a, b) => b.changedAt!.localeCompare(a.changedAt!))[0] ?? null
  );
}

export function activeCollection(state: WorkspaceState): Surface | null {
  const focused = state.surfaces.find((s) => s.id === state.focusId && s.query);
  if (focused) return focused;
  return (
    state.surfaces
      .filter((s) => s.query && s.dataset)
      .sort((a, b) => b.turn - a.turn || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
  );
}

type TaskList = SurfacePayloads["task_list"];

/**
 * The same task collection in another form — computed from the collection's own items (never
 * a re-scoped query): a timeline of their due dates, or a table. Tasks without a date can't be
 * placed in time and are counted in the subtitle, never dropped silently.
 */
const STATUS_ES: Record<string, string> = {
  pending: "Pendiente",
  in_progress: "En curso",
  completed: "Hecha",
  cancelled: "Cancelada",
};
const STATUS_EN: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Done",
  cancelled: "Cancelled",
};

/** "sáb 4 oct" (a date-only due date is a calendar day, not an instant). */
function dueLabel(due: string, locale: "es" | "en"): string {
  const day = due.slice(0, 10);
  const label = new Intl.DateTimeFormat(locale === "es" ? "es-AR" : "en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T12:00:00Z`));
  return due.length > 10 ? `${label} ${due.slice(11, 16)}` : label;
}

/** The ids of a task collection's items (kept on its timeline / table form). */
export function memberIds(list: unknown): string[] {
  return ((list as Partial<TaskList> | null)?.items ?? []).map((t) => t.id).slice(0, 200);
}

export function representTasks(
  list: TaskList,
  as: "timeline" | "table",
  opts: { title: string; locale: "es" | "en"; today: string },
): VisualizationSpec | null {
  const es = opts.locale === "es";
  const source = { title: es ? "Tareas" : "Tasks", url: "/my-elise/tasks" };
  if (as === "table") {
    const spec = visualizationSpec.safeParse({
      type: "table",
      title: opts.title,
      columns: [
        { label: es ? "Tarea" : "Task" },
        { label: es ? "Vence" : "Due" },
        { label: es ? "Estado" : "Status" },
        { label: es ? "Lista" : "List" },
      ],
      rows: list.items.map((t) => [
        t.title.slice(0, 80),
        t.dueDate ? dueLabel(t.dueDate, opts.locale) : "—",
        (es ? STATUS_ES : STATUS_EN)[t.status] ?? t.status,
        (t.listName ?? t.source).slice(0, 80),
      ]),
      ...(list.total > list.items.length
        ? {
            note: es
              ? `${list.items.length} de ${list.total}`
              : `${list.items.length} of ${list.total}`,
          }
        : {}),
      sources: [source],
    });
    return spec.success ? spec.data : null;
  }
  const dated = list.items.filter((t) => t.dueDate);
  const plan = planTemporal({
    title: opts.title,
    ...(dated.length < list.items.length
      ? {
          subtitle: es
            ? `${list.items.length - dated.length} sin fecha no se muestran en el tiempo`
            : `${list.items.length - dated.length} without a date aren't placed in time`,
        }
      : {}),
    events: dated.map((t) => ({
      title: t.title.slice(0, 100),
      start: t.dueDate!.slice(0, 10),
      kind: "deadline" as const,
      importance: t.dueDate! < opts.today ? ("high" as const) : ("normal" as const),
      detail: (t.listName ?? t.source).slice(0, 160),
      source,
    })),
    view: "timeline",
    today: opts.today,
    explicit: true,
    locale: opts.locale,
  });
  return plan.ok ? plan.spec : null;
}

/**
 * A new view drawn entirely from one visible Surface (every source is its handle) shows that
 * Surface's data: it inherits its dataset and query, so it replaces it instead of piling up.
 */
export function inheritedFrom(
  state: WorkspaceState,
  sources: readonly string[],
): Pick<Surface, "dataset" | "query"> | null {
  const handles = new Set(sources.map((s) => s.trim()));
  if (handles.size !== 1) return null;
  const origin = state.surfaces.find((s) => s.handle === [...handles][0]);
  return origin?.dataset
    ? { dataset: origin.dataset, ...(origin.query ? { query: origin.query } : {}) }
    : null;
}
