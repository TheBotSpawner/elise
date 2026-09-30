/**
 * Live Workspace (ADR-013): the visual working context around one interaction. Canonical and
 * framework-free: the runtime, the tools and the UI share this model and this reducer, so the
 * browser and the server always arrive at the same state from the same operations.
 */

export const SURFACE_TYPES = [
  "meeting",
  "calendar_event",
  "email_thread",
  "email_list",
  "knowledge_source",
  "knowledge_result",
  "document",
  "recall",
  "task_list",
  "task",
  "person",
  "links",
  "schedule",
  "settings",
  "approval",
  "summary",
  "result",
] as const;
export type SurfaceType = (typeof SURFACE_TYPES)[number];

export const SURFACE_SIZES = ["micro", "small", "medium", "large", "expanded"] as const;
export type SurfaceSize = (typeof SURFACE_SIZES)[number];

export const SURFACE_STATES = ["loading", "ready", "attention", "error", "stale"] as const;
export type SurfaceState = (typeof SURFACE_STATES)[number];

export const INTENT_KINDS = [
  "meeting_prep",
  "research",
  "recall",
  "planning",
  "communication",
  "settings",
  "general",
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

/** How a Surface action runs. The registry decides; the model never does. */
export type ActionKind = "link" | "prompt" | "tool" | "expand" | "approval";

export const ACTION_IDS = [
  "join",
  "open_calendar",
  "open",
  "summarize",
  "draft_reply",
  "complete",
  "open_source",
  "view_interaction",
  "undo",
  "resume",
  "expand",
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

export interface SurfaceAction {
  id: ActionId;
  kind: ActionKind;
  /** Links only: `https:` or an internal path. */
  href?: string;
}

/** The real resource a Surface points to; detail is always loaded from it, never stored. */
export interface SurfaceRef {
  resource:
    | "calendar_event"
    | "email_thread"
    | "task"
    | "knowledge_item"
    | "interaction"
    | "approval"
    | "schedule"
    | "structured_bulk"
    | "settings";
  id: string;
}

export interface SurfaceSource {
  /** Capability it came from ("calendar", "email", "workspace"…). */
  capability: string;
  /** User-facing account or origin ("Personal", "ELISE", "Knowledge"). */
  label: string | null;
}

export interface Surface<P = unknown> {
  /** Stable, deterministic key (type + resource): presenting the same thing updates it. */
  id: string;
  /** Short handle the model and the user refer to ("S2"). */
  handle: string;
  type: SurfaceType;
  title: string;
  state: SurfaceState;
  /** 0–100; decides the primary Surface and what leaves first. */
  priority: number;
  size: SurfaceSize;
  source: SurfaceSource | null;
  ref: SurfaceRef | null;
  /** Small, validated presentation snapshot. */
  payload: P;
  actions: SurfaceAction[];
  intentId: string | null;
  /** Confirmations that disappear on their own; never persisted. */
  transient?: boolean;
  /** Last user turn in which it was presented, updated or focused. */
  turn: number;
  createdAt: string;
  updatedAt: string;
}

/** What a presenter provides; the reducer assigns handle, turn and timestamps. */
export type SurfaceDraft = Omit<Surface, "handle" | "turn" | "createdAt" | "updatedAt"> &
  Partial<Pick<Surface, "handle">>;

export interface ActiveIntent {
  id: string;
  kind: IntentKind;
  description: string;
  startedAt: string;
}

export interface WorkspaceState {
  version: number;
  turn: number;
  intent: ActiveIntent | null;
  surfaces: Surface[];
  focusId: string | null;
  nextHandle: number;
}

export type WorkspaceOp =
  | { op: "present"; surface: SurfaceDraft; at: string }
  | {
      op: "update";
      id: string;
      patch: Partial<Pick<Surface, "title" | "state" | "size" | "priority" | "payload">>;
      at: string;
    }
  | { op: "focus"; id: string | null; at: string }
  | { op: "dismiss"; id: string; at: string }
  | { op: "clear"; at: string }
  | { op: "intent"; intent: ActiveIntent; at: string }
  /** A new user turn: Surfaces nobody has touched for a while decay away. */
  | { op: "turn"; at: string };

export const WORKSPACE_LIMITS = {
  maxVisible: 6,
  decayTurns: 4,
  staleAfterMs: 15 * 60_000,
  /** Transient confirmations disappear after this (UI timer). */
  transientMs: 6_000,
  ttlMs: 12 * 3_600_000,
} as const;

export const emptyWorkspace = (): WorkspaceState => ({
  version: 0,
  turn: 0,
  intent: null,
  surfaces: [],
  focusId: null,
  nextHandle: 1,
});

/** Intent kinds that never replace the current intent (a quick settings change mid-prep). */
const TRANSIENT_INTENTS: ReadonlySet<IntentKind> = new Set(["settings"]);

/** A pending approval stays until it is decided, whatever else happens. */
const sticky = (s: Surface) => s.type === "approval" && s.state === "attention";

export function applyOp(state: WorkspaceState, op: WorkspaceOp): WorkspaceState {
  const next = reduce(state, op);
  return next === state ? state : { ...next, version: state.version + 1 };
}

export function applyOps(state: WorkspaceState, ops: readonly WorkspaceOp[]): WorkspaceState {
  return ops.reduce(applyOp, state);
}

function reduce(state: WorkspaceState, op: WorkspaceOp): WorkspaceState {
  switch (op.op) {
    case "present": {
      const existing = state.surfaces.find((s) => s.id === op.surface.id);
      if (existing) {
        const updated: Surface = {
          ...existing,
          ...op.surface,
          handle: existing.handle,
          createdAt: existing.createdAt,
          turn: state.turn,
          updatedAt: op.at,
        };
        return {
          ...state,
          surfaces: state.surfaces.map((s) => (s.id === existing.id ? updated : s)),
        };
      }
      const surface: Surface = {
        ...op.surface,
        handle: `S${state.nextHandle}`,
        intentId: op.surface.intentId ?? state.intent?.id ?? null,
        turn: state.turn,
        createdAt: op.at,
        updatedAt: op.at,
      };
      return evict({
        ...state,
        surfaces: [...state.surfaces, surface],
        nextHandle: state.nextHandle + 1,
      });
    }
    case "update": {
      if (!state.surfaces.some((s) => s.id === op.id)) return state;
      return {
        ...state,
        surfaces: state.surfaces.map((s) =>
          s.id === op.id ? { ...s, ...op.patch, turn: state.turn, updatedAt: op.at } : s,
        ),
      };
    }
    case "focus": {
      if (op.id === state.focusId) return state;
      if (op.id && !state.surfaces.some((s) => s.id === op.id)) return state;
      return {
        ...state,
        focusId: op.id,
        surfaces: op.id
          ? state.surfaces.map((s) => (s.id === op.id ? { ...s, turn: state.turn } : s))
          : state.surfaces,
      };
    }
    case "dismiss": {
      if (!state.surfaces.some((s) => s.id === op.id)) return state;
      return {
        ...state,
        surfaces: state.surfaces.filter((s) => s.id !== op.id),
        focusId: state.focusId === op.id ? null : state.focusId,
      };
    }
    case "clear": {
      const kept = state.surfaces.filter(sticky);
      if (kept.length === state.surfaces.length && !state.intent) return state;
      return { ...state, surfaces: kept, focusId: null, intent: null };
    }
    case "intent": {
      if (TRANSIENT_INTENTS.has(op.intent.kind)) return state;
      if (state.intent?.id === op.intent.id) return state;
      // A new primary intent: the previous one's Surfaces leave (pending approvals stay).
      const kept = state.surfaces.filter((s) => sticky(s) || s.intentId === op.intent.id);
      return {
        ...state,
        intent: op.intent,
        surfaces: kept,
        focusId: kept.some((s) => s.id === state.focusId) ? state.focusId : null,
      };
    }
    case "turn": {
      const turn = state.turn + 1;
      const kept = state.surfaces.filter(
        (s) => !s.transient && (sticky(s) || turn - s.turn < WORKSPACE_LIMITS.decayTurns),
      );
      return {
        ...state,
        turn,
        surfaces: kept,
        focusId: kept.some((s) => s.id === state.focusId) ? state.focusId : null,
        intent: kept.length ? state.intent : null,
      };
    }
  }
}

/** Over capacity: the lowest-priority, least recently touched Surface leaves. */
function evict(state: WorkspaceState): WorkspaceState {
  let surfaces = state.surfaces;
  while (surfaces.length > WORKSPACE_LIMITS.maxVisible) {
    const candidates = surfaces
      .filter((s) => s.id !== state.focusId && !sticky(s))
      .sort((a, b) => a.priority - b.priority || a.updatedAt.localeCompare(b.updatedAt));
    const out = candidates[0];
    if (!out) break;
    surfaces = surfaces.filter((s) => s !== out);
  }
  return surfaces === state.surfaces ? state : { ...state, surfaces };
}

/** After a reload: confirmations are gone, and older snapshots say they may be outdated. */
export function restoreWorkspace(state: WorkspaceState, now: Date): WorkspaceState {
  const surfaces = state.surfaces
    .filter((s) => !s.transient)
    .map((s) =>
      s.state === "ready" &&
      s.type !== "summary" &&
      now.getTime() - Date.parse(s.updatedAt) > WORKSPACE_LIMITS.staleAfterMs
        ? { ...s, state: "stale" as const }
        : s,
    );
  return { ...state, surfaces };
}

/** The Surface shown largest: the focused one, else the highest priority (oldest on ties). */
export function primarySurface(state: WorkspaceState): Surface | null {
  const focused = state.surfaces.find((s) => s.id === state.focusId);
  if (focused) return focused;
  return (
    [...state.surfaces].sort(
      (a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
    )[0] ?? null
  );
}

/** `https:` or an internal path. Anything else (javascript:, data:, //host) is refused. */
export function isSafeHref(href: string): boolean {
  if (href.startsWith("/")) return !href.startsWith("//") && !href.startsWith("/\\");
  try {
    return new URL(href).protocol === "https:";
  } catch {
    return false;
  }
}

/** Deterministic id for "the same thing" (so presenting it again updates in place). */
export function surfaceId(type: SurfaceType, key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${type}:${h.toString(36)}`;
}
