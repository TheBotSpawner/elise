/**
 * Live Workspace (ADR-013): the visual working context around one interaction. Canonical and
 * framework-free: the runtime, the tools and the UI share this model and this reducer, so the
 * browser and the server always arrive at the same state from the same operations.
 */

export const SURFACE_TYPES = [
  "meeting",
  "calendar_event",
  "calendar",
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
  "web_results",
  "web_source",
  "web_news",
  "web_research",
  "web_collection",
  "context_overview",
  "context_proposal",
  "commitments",
  "timeline",
  "study_question",
  "study_progress",
  "study_summary",
  "shortcut",
  "visualization",
  "media",
  "map",
  "place",
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
  "study",
  "work_brief",
  "context_setup",
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
  "save",
  "hint",
  "next",
  "reveal",
  "end_session",
  "review_weak",
  "create_task",
  "research",
  "create_context",
  "save_shortcut",
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
    | "settings"
    | "web_page"
    | "context_profile"
    | "study_session"
    | "place";
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
  /** Kept when the context moves on (decay, a new intent, clear) until unpinned (ADR-021). */
  pinned?: boolean;
  /** One side of the current comparison (ADR-021). */
  compared?: boolean;
  /** The item inside this Surface that is in focus (an email of a list, a timeline entry). */
  focusItem?: string;
  /** The read that produced it (collections): re-run to stay current after writes (ADR-029). */
  query?: { tool: string; args: Record<string, unknown> };
  /**
   * What data it shows (ADR-031): a read's query, a resource ("task:<id>"). Another Surface of
   * the same dataset replaces it (a list shown as a timeline), unless pinned or kept.
   */
  dataset?: string;
  /** How a collection is shown; kept when it refreshes (ADR-031). */
  presentation?: "list" | "timeline" | "table";
  /** Resource ids a collection shown in another form contains (its payload has no ids). */
  members?: string[];
  /** When a write produced or changed it: the latest is what "mostramelo" means. */
  changedAt?: string;
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
  /** "time": show what happened in order (Temporal); absent: by relevance (ADR-021). */
  arrangement?: "time";
}

/**
 * The area of the user's world this interaction is about (ADR-016 §6): separate from the
 * intent, ephemeral, and never an authorization. `turn` is when it was last used.
 */
export interface ActiveContext {
  id: string;
  name: string;
  kind: "study" | "client" | "project" | "work" | "custom";
  accent: string | null;
  turn: number;
}

export interface WorkspaceState {
  version: number;
  turn: number;
  intent: ActiveIntent | null;
  context: ActiveContext | null;
  surfaces: Surface[];
  focusId: string | null;
  nextHandle: number;
}

export type WorkspaceOp =
  /**
   * Present (or update by id). A new Surface replaces visible unpinned ones of the same dataset
   * — taking their handle and Focus — unless `keep` asks to show both (ADR-031).
   */
  | { op: "present"; surface: SurfaceDraft; at: string; keep?: boolean }
  | {
      op: "update";
      id: string;
      patch: Partial<
        Pick<
          Surface,
          | "title"
          | "state"
          | "size"
          | "priority"
          | "payload"
          | "changedAt"
          | "focusItem"
          | "members"
          | "query"
        >
      >;
      at: string;
    }
  /**
   * Bring one Surface to the front (null: back to the whole workspace). `item` focuses one
   * entry inside it; `compareWith` puts a second Surface beside it (ADR-021).
   */
  | {
      op: "focus";
      id: string | null;
      item?: string | null;
      compareWith?: string | null;
      at: string;
    }
  | { op: "pin"; id: string; pinned: boolean; at: string }
  /** How the workspace is ordered: by relevance, or in time order (Temporal). */
  | { op: "arrange"; order: "time" | "relevance"; at: string }
  | { op: "dismiss"; id: string; at: string }
  | { op: "clear"; at: string }
  | { op: "intent"; intent: ActiveIntent; at: string }
  /**
   * The active context: the same id marks it used now; another id switches (the previous
   * context's Surfaces leave, pending approvals stay); null clears it (Surfaces stay).
   */
  | { op: "context"; context: Omit<ActiveContext, "turn"> | null; at: string }
  /** A new user turn: Surfaces nobody has touched for a while decay away. */
  | { op: "turn"; at: string };

export const WORKSPACE_LIMITS = {
  /** The Live Canvas has room for 8 on large screens; smaller ones shelve the rest (ADR-021). */
  maxVisible: 8,
  decayTurns: 4,
  staleAfterMs: 15 * 60_000,
  /** Transient confirmations disappear after this (UI timer). */
  transientMs: 9_000,
  ttlMs: 12 * 3_600_000,
  /** An active context nobody used for this many turns decays away (ADR-016 §6). */
  contextDecayTurns: 6,
  /** Pinned Surfaces: one more unpins the least recently touched one (ADR-021). */
  maxPinned: 3,
} as const;

export const emptyWorkspace = (): WorkspaceState => ({
  version: 0,
  turn: 0,
  intent: null,
  context: null,
  surfaces: [],
  focusId: null,
  nextHandle: 1,
});

/** Intent kinds that never replace the current intent (a quick settings change mid-prep). */
const TRANSIENT_INTENTS: ReadonlySet<IntentKind> = new Set(["settings"]);

/** A pending approval stays until it is decided, whatever else happens. */
const sticky = (s: Surface) => s.type === "approval" && s.state === "attention";
/** What stays when the context moves on: pending approvals and pinned Surfaces. */
const kept = (s: Surface) => sticky(s) || Boolean(s.pinned);

/** A Surface without its view flags (compared, focusItem). */
function plain(s: Surface): Surface {
  const next = { ...s };
  delete next.compared;
  delete next.focusItem;
  return next;
}

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
      // Same data, another representation: the old one is superseded — replaced in place.
      const replaced =
        op.surface.dataset && !op.keep
          ? state.surfaces.filter(
              (s) => s.dataset === op.surface.dataset && !s.pinned && s.type !== "approval",
            )
          : [];
      const heir = replaced[0];
      const surface: Surface = {
        ...op.surface,
        handle: heir?.handle ?? `S${state.nextHandle}`,
        intentId: op.surface.intentId ?? state.intent?.id ?? null,
        turn: state.turn,
        createdAt: op.at,
        updatedAt: op.at,
      };
      const gone = new Set(replaced.map((s) => s.id));
      // It takes the old one's place in order, so the Canvas reflows instead of reshuffling.
      const at = heir ? state.surfaces.findIndex((s) => s.id === heir.id) : -1;
      const kept = state.surfaces.filter((s) => !gone.has(s.id));
      const surfaces =
        at >= 0 ? [...kept.slice(0, at), surface, ...kept.slice(at)] : [...kept, surface];
      return evict({
        ...state,
        surfaces,
        nextHandle: heir ? state.nextHandle : state.nextHandle + 1,
        focusId: state.focusId && gone.has(state.focusId) ? surface.id : state.focusId,
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
      const id = op.id;
      if (id && !state.surfaces.some((s) => s.id === id)) return state;
      const other =
        id &&
        op.compareWith &&
        op.compareWith !== id &&
        state.surfaces.some((s) => s.id === op.compareWith)
          ? op.compareWith
          : null;
      const item = id ? (op.item ?? null) : null;
      const view = (s: Surface) => {
        const compared = other !== null && (s.id === id || s.id === other);
        return { compared, item: s.id === id ? item : null };
      };
      const unchanged =
        id === state.focusId &&
        state.surfaces.every(
          (s) => Boolean(s.compared) === view(s).compared && (s.focusItem ?? null) === view(s).item,
        );
      if (unchanged) return state;
      return {
        ...state,
        focusId: id,
        surfaces: state.surfaces.map((s) => {
          const v = view(s);
          const next = plain(s);
          if (s.id === id || s.id === other) next.turn = state.turn;
          if (v.compared) next.compared = true;
          if (v.item) next.focusItem = v.item;
          return next;
        }),
      };
    }
    case "pin": {
      const target = state.surfaces.find((s) => s.id === op.id);
      if (!target || Boolean(target.pinned) === op.pinned) return state;
      const unpin = (s: Surface): Surface => {
        const next = { ...s };
        delete next.pinned;
        return next;
      };
      let surfaces = state.surfaces.map((s) =>
        s.id !== op.id
          ? s
          : op.pinned
            ? { ...s, pinned: true, turn: state.turn, updatedAt: op.at }
            : unpin(s),
      );
      const pinned = surfaces.filter((s) => s.pinned && s.id !== op.id);
      if (op.pinned && pinned.length >= WORKSPACE_LIMITS.maxPinned) {
        const oldest = [...pinned].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0]!;
        surfaces = surfaces.map((s) => (s.id === oldest.id ? unpin(s) : s));
      }
      return { ...state, surfaces };
    }
    case "arrange": {
      const time = op.order === "time";
      if (Boolean(state.intent?.arrangement) === time) return state;
      // Arranging never changes the intent itself, so no Surface leaves.
      const intent: ActiveIntent = {
        ...(state.intent ?? {
          id: `arranged:${op.at}`,
          kind: "general" as const,
          description: "",
          startedAt: op.at,
        }),
      };
      delete intent.arrangement;
      return { ...state, intent: time ? { ...intent, arrangement: "time" } : intent };
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
      const left = state.surfaces.filter(kept).map(plain);
      if (left.length === state.surfaces.length && !state.intent && !state.focusId) return state;
      return { ...state, surfaces: left, focusId: null, intent: null };
    }
    case "intent": {
      if (TRANSIENT_INTENTS.has(op.intent.kind)) return state;
      if (state.intent?.id === op.intent.id) return state;
      // A new primary intent: the previous one's Surfaces leave (approvals and pins stay).
      const left = state.surfaces.filter((s) => kept(s) || s.intentId === op.intent.id);
      return {
        ...state,
        intent: op.intent,
        surfaces: left,
        focusId: left.some((s) => s.id === state.focusId) ? state.focusId : null,
      };
    }
    case "context": {
      const next = op.context;
      if (!next) return state.context ? { ...state, context: null } : state;
      if (state.context?.id === next.id) {
        const same =
          state.context.turn === state.turn &&
          state.context.name === next.name &&
          state.context.accent === next.accent;
        return same ? state : { ...state, context: { ...next, turn: state.turn } };
      }
      // Another context: what belonged to the previous one leaves (approvals and pins stay).
      const left = state.context ? state.surfaces.filter(kept) : state.surfaces;
      return {
        ...state,
        context: { ...next, turn: state.turn },
        surfaces: left,
        intent: state.context ? null : state.intent,
        focusId: left.some((s) => s.id === state.focusId) ? state.focusId : null,
      };
    }
    case "turn": {
      const turn = state.turn + 1;
      const left = state.surfaces.filter(
        (s) => !s.transient && (kept(s) || turn - s.turn < WORKSPACE_LIMITS.decayTurns),
      );
      return {
        ...state,
        turn,
        surfaces: left,
        focusId: left.some((s) => s.id === state.focusId) ? state.focusId : null,
        intent: left.length ? state.intent : null,
        context:
          state.context && turn - state.context.turn < WORKSPACE_LIMITS.contextDecayTurns
            ? state.context
            : null,
      };
    }
  }
}

/** Over capacity: the lowest-priority, least recently touched Surface leaves. */
function evict(state: WorkspaceState): WorkspaceState {
  let surfaces = state.surfaces;
  while (surfaces.length > WORKSPACE_LIMITS.maxVisible) {
    const candidates = surfaces
      .filter((s) => s.id !== state.focusId && !kept(s))
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

/** A task that still needs doing (shared by the registry and the UI; no schema dependency). */
export const isOpen = (status: string) => status === "pending" || status === "in_progress";
