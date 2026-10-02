import type { Surface, SurfaceType, WorkspaceState } from "@/core/workspace/model";
import type { SurfacePayloads } from "@/core/workspace/registry";

/**
 * The Composition Resolver (ADR-021): workspace state + screen → one of a few predefined
 * compositions. Deterministic and centralized: no Surface decides where it goes, and ELISE
 * never sends layout. Same input, same canvas.
 *
 *   approval pending          → its overlay, on top of whatever is below (dimmed)
 *   a focused Surface         → Focus (Comparison when a second one is compared)
 *   arranged in time order    → Temporal (when there are enough dated items)
 *   1–2 Surfaces              → Simple
 *   a clear lead (≥ 85)       → Brief (lead + supporting columns)
 *   several, no clear lead    → Spatial (ELISE at the center, context around)
 *   nothing yet               → Idle / Conversation / Gathering
 */

export type Device = "mobile" | "tablet" | "desktop" | "wide";

export const BREAKPOINTS = { tablet: 768, desktop: 1280, wide: 1800 } as const;

export function deviceFor(width: number): Device {
  if (width < BREAKPOINTS.tablet) return "mobile";
  if (width < BREAKPOINTS.desktop) return "tablet";
  if (width < BREAKPOINTS.wide) return "desktop";
  return "wide";
}

export type CompositionKind =
  | "idle"
  | "conversation"
  | "gathering"
  | "simple"
  | "brief"
  | "spatial"
  | "focus"
  | "comparison"
  | "temporal";

export type Zone =
  | "main"
  | "side"
  | "rail"
  | "left"
  | "right"
  | "bottom"
  | "focus"
  | "compare"
  | "railLeft"
  | "railRight"
  | "stack"
  | "carousel"
  | "list";

/** The design's scale: micro (status), small (glance), medium, large (lead), focus. */
export type VisualSize = "micro" | "small" | "medium" | "large" | "focus";

/** How loud a Surface is: the lead, support, quiet context, just arrived, or behind a decision. */
export type Tier = "primary" | "secondary" | "ambient" | "arriving" | "dim";

export interface Slot {
  id: string;
  zone: Zone;
  size: VisualSize;
  tier: Tier;
}

export interface TemporalItem {
  surfaceId: string;
  /** The entry inside the Surface (focus target), when it is one of several. */
  item: string | null;
  at: string;
  kind: "meeting" | "event" | "email" | "task" | "document" | "recall" | "news" | "record";
  title: string;
  detail: string | null;
  upcoming: boolean;
}

export interface Composition {
  kind: CompositionKind;
  /** In reading order: what the keyboard and a screen reader meet first. */
  slots: Slot[];
  /** Surfaces with no room on this screen: one chip each, never dropped. */
  shelf: string[];
  /** A pending approval shown above everything (the rest stays, dimmed). */
  approvalId: string | null;
  /** Where ELISE's presence sits: the idle hero, the center of Spatial, or the dock. */
  orb: "hero" | "center" | "dock";
  /** The lead Surface (focused, compared first, or highest priority). */
  primaryId: string | null;
  /** Temporal only: dated items, oldest first. */
  timeline: TemporalItem[];
}

export interface CanvasInput {
  state: WorkspaceState;
  device: Device;
  /** Messages exist in this interaction (a conversation, not the idle Home). */
  hasMessages: boolean;
  /** A turn is streaming. */
  running: boolean;
  /** Tool steps still running in this turn (for the gathering state). */
  activeSteps: number;
  now: number;
}

/** Glanceable types that fit a narrow rail without losing meaning. */
const COMPACT: ReadonlySet<SurfaceType> = new Set([
  "person",
  "document",
  "links",
  "task",
  "settings",
  "schedule",
  "shortcut",
]);

const isKpi = (s: Surface) =>
  s.type === "visualization" && (s.payload as SurfacePayloads["visualization"]).spec.type === "kpi";

export const isCompact = (s: Surface) =>
  COMPACT.has(s.type) ||
  isKpi(s) ||
  (s.type === "media" && (s.payload as SurfacePayloads["media"]).kind === "link");

const isPendingApproval = (s: Surface) => s.type === "approval" && s.state === "attention";

/** Priority order (pinned first among equals), oldest first on ties: stable across renders. */
function ordered(surfaces: Surface[]): Surface[] {
  return [...surfaces].sort(
    (a, b) =>
      b.priority + (b.pinned ? 5 : 0) - (a.priority + (a.pinned ? 5 : 0)) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

function tierOf(s: Surface, input: CanvasInput, lead: boolean): Tier {
  if (lead) return "primary";
  if (input.running && s.turn === input.state.turn && s.createdAt === s.updatedAt)
    return "arriving";
  if (!s.pinned && (s.priority < 40 || input.state.turn - s.turn >= 2)) return "ambient";
  return "secondary";
}

const slot = (id: string, zone: Zone, size: VisualSize, tier: Tier): Slot => ({
  id,
  zone,
  size,
  tier,
});

const empty = (kind: CompositionKind, orb: Composition["orb"] = "dock"): Composition => ({
  kind,
  slots: [],
  shelf: [],
  approvalId: null,
  orb,
  primaryId: null,
  timeline: [],
});

export function resolveComposition(input: CanvasInput): Composition {
  const visible = input.state.surfaces.filter((s) => !s.transient);
  const approval = ordered(visible.filter(isPendingApproval))[0] ?? null;
  const rest = visible.filter((s) => s !== approval);
  const base = compose(rest, input);
  if (!approval) return base;
  // A decision is waiting: it comes first, and the workspace behind it stays as it was.
  return {
    ...base,
    kind: base.kind === "idle" || base.kind === "conversation" ? "simple" : base.kind,
    approvalId: approval.id,
    orb: "dock",
    slots: base.slots.map((s) => ({ ...s, tier: "dim" })),
  };
}

function compose(surfaces: Surface[], input: CanvasInput): Composition {
  const { state, device } = input;
  if (!surfaces.length) {
    if (input.running && input.activeSteps > 0) return empty("gathering");
    return input.hasMessages ? empty("conversation") : empty("idle", "hero");
  }
  const focused = surfaces.find((s) => s.id === state.focusId) ?? null;
  if (focused) {
    const other = surfaces.find((s) => s.compared && s.id !== focused.id) ?? null;
    return focus(surfaces, focused, focused.compared && other ? other : null, input);
  }
  if (state.intent?.arrangement === "time") {
    const timeline = temporalItems(surfaces, input.now);
    if (timeline.length >= 3) return temporal(surfaces, timeline, input);
  }
  if (surfaces.length <= 2) return simple(surfaces, input);
  const list = ordered(surfaces);
  const lead = list[0]!;
  if (lead.priority < 85 && (device === "desktop" || device === "wide") && !isKpi(lead))
    return spatial(list, input);
  if (device === "mobile" && lead.priority < 85) return spatial(list, input);
  return brief(list, input);
}

function simple(surfaces: Surface[], input: CanvasInput): Composition {
  const [lead, second] = ordered(surfaces);
  const slots = [slot(lead!.id, "main", "large", tierOf(lead!, input, true))];
  if (second)
    slots.push(
      slot(
        second.id,
        input.device === "mobile" ? "stack" : "side",
        isCompact(second) ? "small" : "medium",
        tierOf(second, input, false),
      ),
    );
  return { ...empty("simple"), slots, primaryId: lead!.id };
}

/** A lead Surface with the context around it (meeting prep, a plan, a research result). */
function brief(list: Surface[], input: CanvasInput): Composition {
  const { device } = input;
  // A headline number reads better beside its chart than as the lead.
  const chart = isKpi(list[0]!) ? list.find((s) => s.type === "visualization" && !isKpi(s)) : null;
  const lead = chart ?? list[0]!;
  const others = list.filter((s) => s !== lead);
  const slots: Slot[] = [slot(lead.id, "main", "large", tierOf(lead, input, true))];
  const shelf: string[] = [];
  const take = (s: Surface, zone: Zone, size: VisualSize) =>
    slots.push(slot(s.id, zone, size, tierOf(s, input, false)));

  if (device === "mobile") {
    for (const s of others.slice(0, 2)) take(s, "stack", "medium");
    shelf.push(...others.slice(2).map((s) => s.id));
    return { ...empty("brief"), slots, shelf, primaryId: lead.id };
  }

  const wide = device === "wide";
  const caps =
    device === "tablet"
      ? { main: 1, side: 2, rail: 0 }
      : { main: 2, side: wide ? 4 : 3, rail: wide ? 3 : 2 };
  // The brief summary of an orchestration reads right under its lead (meeting → brief).
  const summary = others.find((s) => s.type === "summary");
  const main: Surface[] = summary && caps.main > 1 ? [summary] : [];
  let pool = others.filter((s) => !main.includes(s));
  const rail = caps.rail ? pool.filter(isCompact).slice(0, caps.rail) : [];
  pool = pool.filter((s) => !rail.includes(s));
  const side = pool.slice(0, caps.side);
  pool = pool.filter((s) => !side.includes(s));
  // One quiet leftover can sit under the lead (web context under a meeting).
  if (pool.length && main.length < caps.main) main.push(pool.shift()!);
  for (const s of main) take(s, "main", s.type === "summary" ? "large" : "medium");
  for (const s of side) take(s, "side", isCompact(s) ? "small" : "medium");
  for (const s of rail) take(s, "rail", "small");
  shelf.push(...pool.map((s) => s.id));
  return { ...empty("brief"), slots, shelf, primaryId: lead.id };
}

/** Broad context without one lead: ELISE in the middle, the sources around her. */
function spatial(list: Surface[], input: CanvasInput): Composition {
  if (input.device === "mobile") {
    const slots = list
      .slice(0, 2)
      .map((s, i) => slot(s.id, "carousel", "medium", tierOf(s, input, i === 0)));
    for (const s of list.slice(2, 7))
      slots.push(slot(s.id, "list", "micro", tierOf(s, input, false)));
    return {
      ...empty("spatial", "center"),
      slots,
      shelf: list.slice(7).map((s) => s.id),
      primaryId: list[0]!.id,
    };
  }
  const slots: Slot[] = [];
  const quiet = list.length > 4 ? list.at(-1)! : null;
  const around = list.filter((s) => s !== quiet);
  const perSide = 3;
  const count = { left: 0, right: 0 };
  const shelf: string[] = [];
  // Alternate sides by priority; a full side passes to the other; both full → the shelf.
  around.forEach((s, i) => {
    const preferred = i % 2 === 0 ? "left" : "right";
    const other = preferred === "left" ? "right" : "left";
    const zone = count[preferred] < perSide ? preferred : count[other] < perSide ? other : null;
    if (!zone) return void shelf.push(s.id);
    count[zone]++;
    slots.push(slot(s.id, zone, isCompact(s) ? "small" : "medium", tierOf(s, input, i === 0)));
  });
  if (quiet) slots.push(slot(quiet.id, "bottom", "small", tierOf(quiet, input, false)));
  // Reading order: left column, then right, then the quiet one below.
  const rank: Partial<Record<Zone, number>> = { left: 0, right: 1, bottom: 2 };
  slots.sort((a, b) => (rank[a.zone] ?? 0) - (rank[b.zone] ?? 0));
  return { ...empty("spatial", "center"), slots, shelf, primaryId: list[0]!.id };
}

/** One Surface is the work; the rest stays reachable, reduced, in the rails. */
function focus(
  surfaces: Surface[],
  focused: Surface,
  compared: Surface | null,
  input: CanvasInput,
): Composition {
  const { device } = input;
  const kind: CompositionKind = compared ? "comparison" : "focus";
  const slots: Slot[] = compared
    ? [
        slot(focused.id, "compare", "large", "primary"),
        slot(compared.id, "compare", "large", "primary"),
      ]
    : [slot(focused.id, "focus", "focus", "primary")];
  const others = ordered(surfaces.filter((s) => s !== focused && s !== compared));
  const shelf: string[] = [];
  if (device === "mobile") {
    shelf.push(...others.map((s) => s.id));
    return { ...empty(kind), slots, shelf, primaryId: focused.id };
  }
  const caps = device === "tablet" ? { left: 0, right: 4 } : { left: 4, right: 4 };
  let left = 0;
  let right = 0;
  // Pinned Surfaces keep their content on the right; the rest shrink to a title.
  for (const s of others) {
    const toRight = s.pinned || caps.left === 0 || (right <= left && right < caps.right);
    if (toRight && right < caps.right) {
      right++;
      slots.push(slot(s.id, "railRight", s.pinned ? "small" : "micro", tierOf(s, input, false)));
    } else if (left < caps.left) {
      left++;
      slots.push(slot(s.id, "railLeft", "micro", tierOf(s, input, false)));
    } else shelf.push(s.id);
  }
  return { ...empty(kind), slots, shelf, primaryId: focused.id };
}

function temporal(surfaces: Surface[], timeline: TemporalItem[], input: CanvasInput): Composition {
  const onAxis = new Set(timeline.map((t) => t.surfaceId));
  const others = ordered(surfaces.filter((s) => !onAxis.has(s.id)));
  const room = input.device === "mobile" ? 0 : 4;
  return {
    ...empty("temporal"),
    slots: others
      .slice(0, room)
      .map((s) => slot(s.id, "railRight", "micro", tierOf(s, input, false))),
    shelf: others.slice(room).map((s) => s.id),
    primaryId: timeline[0]?.surfaceId ?? null,
    timeline,
  };
}

// ── Time-anchored items (what Temporal can place on its axis) ────────────────

const MAX_PER_SURFACE = 4;
const MAX_ITEMS = 16;

/** Dated items from the visible Surfaces, oldest first. Undated things never get a date. */
export function temporalItems(surfaces: Surface[], now: number): TemporalItem[] {
  const out: TemporalItem[] = [];
  const push = (s: Surface, it: Omit<TemporalItem, "surfaceId" | "upcoming">) => {
    const t = Date.parse(it.at.length === 10 ? `${it.at}T12:00:00Z` : it.at);
    if (Number.isFinite(t)) out.push({ ...it, surfaceId: s.id, upcoming: t > now });
  };
  for (const s of surfaces) {
    switch (s.type) {
      case "meeting":
      case "calendar_event": {
        const p = s.payload as SurfacePayloads["meeting"];
        push(s, { item: null, at: p.start, kind: "meeting", title: p.title, detail: null });
        break;
      }
      case "email_thread": {
        const p = s.payload as SurfacePayloads["email_thread"];
        if (p.latest)
          push(s, {
            item: null,
            at: p.latest.date,
            kind: "email",
            title: p.subject,
            detail: p.latest.from,
          });
        break;
      }
      case "email_list":
        for (const m of (s.payload as SurfacePayloads["email_list"]).items.slice(
          0,
          MAX_PER_SURFACE,
        ))
          push(s, {
            item: m.threadId,
            at: m.date,
            kind: "email",
            title: m.subject,
            detail: m.from?.name ?? m.from?.email ?? null,
          });
        break;
      case "recall":
        for (const r of (s.payload as SurfacePayloads["recall"]).results.slice(0, MAX_PER_SURFACE))
          push(s, {
            item: r.interactionId,
            at: r.date,
            kind: "recall",
            title: r.title,
            detail: null,
          });
        break;
      case "task_list":
        for (const t of (s.payload as SurfacePayloads["task_list"]).items)
          if (t.dueDate && out.filter((o) => o.surfaceId === s.id).length < MAX_PER_SURFACE)
            push(s, {
              item: t.id,
              at: t.dueDate,
              kind: "task",
              title: t.title,
              detail: t.listName,
            });
        break;
      case "task": {
        const t = (s.payload as SurfacePayloads["task"]).task;
        if (t.dueDate)
          push(s, { item: null, at: t.dueDate, kind: "task", title: t.title, detail: t.listName });
        break;
      }
      case "document": {
        const p = s.payload as SurfacePayloads["document"];
        push(s, {
          item: null,
          at: p.updatedAt,
          kind: "document",
          title: p.title,
          detail: p.spaceName,
        });
        break;
      }
      case "timeline":
        (s.payload as SurfacePayloads["timeline"]).entries.forEach((e, i) =>
          push(s, {
            item: String(i),
            at: e.at,
            kind:
              e.kind === "meeting"
                ? "meeting"
                : e.kind === "email"
                  ? "email"
                  : e.kind === "task"
                    ? "task"
                    : e.kind === "document"
                      ? "document"
                      : e.kind === "interaction"
                        ? "recall"
                        : "record",
            title: e.title,
            detail: e.detail,
          }),
        );
        break;
      case "web_news":
        for (const e of (s.payload as SurfacePayloads["web_news"]).events.slice(
          0,
          MAX_PER_SURFACE,
        )) {
          const first = e.items[0];
          if (first?.publishedAt)
            push(s, {
              item: first.url,
              at: first.publishedAt,
              kind: "news",
              title: e.headline,
              detail: first.domain,
            });
        }
        break;
      default:
        break;
    }
  }
  return out
    .sort(
      (a, b) => Date.parse(norm(a.at)) - Date.parse(norm(b.at)) || a.title.localeCompare(b.title),
    )
    .slice(-MAX_ITEMS);
}

const norm = (at: string) => (at.length === 10 ? `${at}T12:00:00Z` : at);
