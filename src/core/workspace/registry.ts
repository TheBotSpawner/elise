import { z } from "zod";

import { TASK_STATUSES } from "../capabilities/tasks";
import { toLocalDateTime } from "../time";
import {
  ACTION_IDS,
  INTENT_KINDS,
  isSafeHref,
  SURFACE_SIZES,
  SURFACE_STATES,
  SURFACE_TYPES,
  emptyWorkspace,
  type ActionId,
  type Surface,
  type SurfaceAction,
  type SurfaceSize,
  type SurfaceType,
  type WorkspaceState,
} from "./model";

/**
 * Surface registry (ADR-013), in the spirit of the capability registry: each type declares its
 * payload schema, sizes, actions, how it is described to the model and which tool its direct
 * actions call. The UI maps the same types to renderers; nothing here knows about React.
 */

const text = (max: number) => z.string().max(max);
const href = z.string().max(2000).refine(isSafeHref, "Only https: or internal links");
const address = z.object({ name: text(200).nullable(), email: text(320) });

const eventPayload = z.object({
  eventId: text(1000),
  title: text(300),
  start: text(40),
  end: text(40),
  allDay: z.boolean(),
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  location: text(500).nullable(),
  description: text(800).nullable(),
  calendarName: text(200),
  account: text(200),
  htmlUrl: href.nullable(),
  meetingUrl: href.nullable(),
  attendees: z
    .array(
      z.object({
        name: text(200).nullable(),
        email: text(320),
        response: z.enum(["accepted", "declined", "tentative", "needsAction"]).nullable(),
        organizer: z.boolean(),
        self: z.boolean(),
      }),
    )
    .max(25),
});

const emailItem = z.object({
  messageId: text(1000),
  threadId: text(1000),
  subject: text(300),
  from: address.nullable(),
  date: text(40),
  snippet: text(300),
  unread: z.boolean(),
  needsReply: z.boolean().optional(),
  account: text(200),
});

const taskItem = z.object({
  id: text(1000),
  title: text(300),
  status: z.enum(TASK_STATUSES),
  dueDate: text(10).nullable(),
  priority: text(20).nullable(),
  source: text(200),
  listName: text(200).nullable(),
});

const passage = z.object({
  ref: z.number().int(),
  chunkId: text(100),
  section: text(300).nullable(),
  page: z.number().int().nullable(),
  excerpt: text(600),
});

const knowledgeSource = z.object({
  itemId: text(100),
  title: text(300),
  sourceType: text(40),
  spaceName: text(200),
  url: href.nullable(),
  passages: z.array(passage).max(4),
});

const change = z.object({
  setting: z.enum(["accent", "theme", "timezone", "language", "notifications", "schedule"]),
  from: text(120).nullable(),
  to: text(120),
  subject: text(200).optional(),
});

export const PAYLOADS = {
  meeting: eventPayload,
  calendar_event: eventPayload,
  email_list: z.object({ items: z.array(emailItem).max(8), query: text(200).optional() }),
  email_thread: z.object({
    threadId: text(1000),
    subject: text(300),
    participants: z.array(text(200)).max(10),
    messageCount: z.number().int(),
    latest: z.object({ from: text(200), date: text(40), excerpt: text(700) }).nullable(),
    url: href.nullable(),
    account: text(200),
  }),
  knowledge_result: z.object({
    query: text(300).optional(),
    enough: z.boolean(),
    sources: z.array(knowledgeSource).max(6),
  }),
  knowledge_source: knowledgeSource,
  document: z.object({
    itemId: text(100),
    title: text(300),
    sourceType: text(40),
    spaceName: text(200),
    url: href.nullable(),
    updatedAt: text(40),
    versions: z.number().int(),
  }),
  recall: z.object({
    query: text(300).optional(),
    results: z
      .array(
        z.object({
          interactionId: text(100),
          title: text(300),
          date: text(40),
          summary: text(1200).nullable(),
          excerpts: z.array(z.object({ text: text(500), at: text(40) })).max(2),
          url: href.nullable(),
          /** A spoken interaction shows it ("Voice interaction · Sep 30"). */
          modality: z.enum(["text", "voice", "proactive", "live"]).optional(),
        }),
      )
      .max(5),
  }),
  task_list: z.object({ items: z.array(taskItem).max(12), total: z.number().int() }),
  task: z.object({
    task: taskItem,
    change: z.enum(["created", "updated", "completed", "reopened", "deleted", "shown"]),
  }),
  person: z.object({
    name: text(200).nullable(),
    email: text(320),
    role: z.enum(["organizer", "attendee"]),
    lastEmailAt: text(40).nullable(),
    threads: z.number().int(),
  }),
  links: z.object({
    links: z
      .array(
        z.object({ title: text(200), url: href, kind: z.enum(["meeting", "document", "web"]) }),
      )
      .max(8),
  }),
  schedule: z.object({
    name: text(200),
    status: text(40),
    nextRunAt: text(40).nullable(),
    proposal: z.unknown().optional(),
  }),
  settings: z.object({ changes: z.array(change).min(1).max(4) }),
  approval: z.object({
    approvalId: text(100),
    summary: text(500),
    reason: text(80),
    tool: text(80),
    preview: z.unknown().optional(),
    decision: z.enum(["approved", "rejected"]).nullable(),
    display: z.unknown().optional(),
    /** Approved work that continues in the background (e.g. a bulk change). */
    background: z.enum(["running", "done", "failed"]).optional(),
  }),
  summary: z.object({
    sections: z
      .array(
        z.object({
          kind: z.enum([
            "facts",
            "context",
            "changes",
            "open_items",
            "questions",
            "suggestions",
            "material",
          ]),
          heading: text(120),
          items: z.array(text(400)).min(1).max(8),
        }),
      )
      .min(1)
      .max(7),
  }),
  /** Any other tool result, rendered by its existing card. */
  result: z.object({ display: z.object({ kind: text(60) }).passthrough() }),
} satisfies Record<SurfaceType, z.ZodType>;

export type SurfacePayloads = { [K in SurfaceType]: z.infer<(typeof PAYLOADS)[K]> };
export type TypedSurface<K extends SurfaceType> = Surface<SurfacePayloads[K]> & { type: K };

/** A direct action resolves to exactly one tool call, built here from the Surface's own data. */
export interface ToolCallSpec {
  name: string;
  args: Record<string, unknown>;
}

interface SurfaceDefinition<K extends SurfaceType> {
  sizes: readonly SurfaceSize[];
  size: SurfaceSize;
  priority: number;
  actions(p: SurfacePayloads[K]): SurfaceAction[];
  describe(p: SurfacePayloads[K], timezone: string): string;
  tool?(p: SurfacePayloads[K], action: ActionId, itemId: string | null): ToolCallSpec | null;
}

export const isOpen = (status: string) => status === "pending" || status === "in_progress";

const link = (id: ActionId, url: string | null | undefined): SurfaceAction[] =>
  url && isSafeHref(url) ? [{ id, kind: "link", href: url }] : [];
const expand: SurfaceAction = { id: "expand", kind: "expand" };
const local = (iso: string, tz: string) =>
  iso.length > 10 ? toLocalDateTime(new Date(iso), tz).replace("T", " ") : iso;
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

const event = <K extends "meeting" | "calendar_event">(priority: number): SurfaceDefinition<K> => ({
  sizes: ["small", "medium", "large", "expanded"],
  size: priority >= 90 ? "large" : "medium",
  priority,
  actions: (p) => [...link("join", p.meetingUrl), ...link("open_calendar", p.htmlUrl), expand],
  describe: (p, tz) =>
    `${q(p.title)} ${local(p.start, tz)}–${local(p.end, tz).slice(-5)} · ${p.attendees.filter((a) => !a.self).length} participants (event ${p.eventId})`,
});

const DEFINITIONS: { [K in SurfaceType]: SurfaceDefinition<K> } = {
  meeting: event(100),
  calendar_event: event(70),
  email_list: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 60,
    actions: () => [expand],
    describe: (p) =>
      p.items
        .map(
          (m, i) =>
            `${i + 1}) ${q(m.subject)} — ${m.from?.name ?? m.from?.email ?? "?"} ${m.date.slice(0, 10)} (thread ${m.threadId}, message ${m.messageId})`,
        )
        .join("; "),
  },
  email_thread: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 65,
    actions: (p) => [
      ...link("open", p.url),
      { id: "summarize", kind: "prompt" },
      { id: "draft_reply", kind: "prompt" },
      expand,
    ],
    describe: (p) =>
      `${q(p.subject)} with ${p.participants.slice(0, 4).join(", ")} · ${p.messageCount} messages (thread ${p.threadId})`,
  },
  knowledge_result: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 55,
    actions: () => [expand],
    describe: (p) =>
      p.sources
        .map((s, i) => `${i + 1}) ${q(s.title)} · ${s.spaceName} (item ${s.itemId})`)
        .join("; "),
  },
  knowledge_source: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 55,
    actions: (p) => [
      { id: "open_source", kind: "link", href: `/knowledge/items/${p.itemId}` },
      { id: "summarize", kind: "prompt" },
      expand,
    ],
    describe: (p) => `${q(p.title)} · ${p.spaceName} (item ${p.itemId})`,
  },
  document: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 55,
    actions: (p) => [
      { id: "open_source", kind: "link", href: `/knowledge/items/${p.itemId}` },
      { id: "summarize", kind: "prompt" },
      expand,
    ],
    describe: (p) => `${q(p.title)} · ${p.spaceName} (item ${p.itemId})`,
  },
  recall: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 58,
    actions: () => [expand],
    describe: (p) =>
      p.results
        .map(
          (r, i) =>
            `${i + 1}) ${r.date.slice(0, 10)} ${q(r.title)} (interaction ${r.interactionId})`,
        )
        .join("; "),
  },
  task_list: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 50,
    actions: () => [{ id: "complete", kind: "tool" }, expand],
    describe: (p) =>
      p.items
        .map(
          (t, i) =>
            `${i + 1}) ${q(t.title)}${isOpen(t.status) ? "" : ` [${t.status}]`} (task ${t.id})`,
        )
        .join("; "),
    tool: (p, action, itemId) => {
      const item = p.items.find((t) => t.id === itemId);
      return action === "complete" && item && isOpen(item.status)
        ? { name: "tasks.complete", args: { taskId: item.id } }
        : null;
    },
  },
  task: {
    sizes: ["micro", "small", "medium"],
    size: "small",
    priority: 45,
    actions: (p) => (isOpen(p.task.status) ? [{ id: "complete", kind: "tool" }] : []),
    describe: (p) => `${q(p.task.title)} [${p.change}] (task ${p.task.id})`,
    tool: (p, action) =>
      action === "complete" && isOpen(p.task.status)
        ? { name: "tasks.complete", args: { taskId: p.task.id } }
        : null,
  },
  person: {
    sizes: ["micro", "small"],
    size: "small",
    priority: 34,
    actions: () => [],
    describe: (p) => `${p.name ?? p.email} <${p.email}>`,
  },
  links: {
    sizes: ["small", "medium"],
    size: "small",
    priority: 35,
    actions: () => [],
    describe: (p) => p.links.map((l) => q(l.title)).join(", "),
  },
  schedule: {
    sizes: ["small", "medium"],
    size: "small",
    priority: 50,
    actions: () => [],
    describe: (p) => `${q(p.name)} ${p.status}`,
  },
  settings: {
    sizes: ["micro", "small"],
    size: "small",
    priority: 30,
    actions: (p) =>
      p.changes.length === 1 && undoFor(p.changes[0]!) ? [{ id: "undo", kind: "tool" }] : [],
    describe: (p) => p.changes.map((c) => `${c.setting} ${c.from ?? "—"} → ${c.to}`).join(", "),
    tool: (p, action) =>
      action === "undo" && p.changes.length === 1 ? undoFor(p.changes[0]!) : null,
  },
  approval: {
    sizes: ["medium", "large"],
    size: "medium",
    priority: 95,
    actions: () => [],
    describe: (p) => `${q(p.summary)} — ${p.decision ?? "waiting for the user's approval"}`,
  },
  summary: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 90,
    actions: () => [],
    describe: (p) => p.sections.map((s) => s.heading).join(" · "),
  },
  result: {
    sizes: ["small", "medium", "large"],
    size: "medium",
    priority: 40,
    actions: () => [],
    describe: (p) => p.display.kind,
  },
};

function undoFor(c: z.infer<typeof change>): ToolCallSpec | null {
  if (!c.from) return null;
  switch (c.setting) {
    case "accent":
      return { name: "appearance.setAccent", args: { accent: c.from } };
    case "theme":
      return { name: "appearance.setTheme", args: { theme: c.from } };
    case "timezone":
      return { name: "settings.update", args: { timezone: c.from } };
    case "language":
      return { name: "settings.update", args: { language: c.from } };
    case "schedule":
      return c.subject
        ? {
            name: c.from === "paused" ? "schedules.pause" : "schedules.resume",
            args: { schedule: c.subject },
          }
        : null;
    default:
      return null;
  }
}

export function surfaceDefinition<K extends SurfaceType>(type: K): SurfaceDefinition<K> {
  return DEFINITIONS[type];
}

/** Defaults from the registry, so presenters only say what is specific. */
export function draftDefaults<K extends SurfaceType>(type: K, payload: SurfacePayloads[K]) {
  const d = DEFINITIONS[type];
  return { size: d.size, priority: d.priority, actions: d.actions(payload) };
}

/**
 * The tool call behind a direct action — only for actions the registry declares on this type,
 * with ids taken from the Surface's own payload. The call still goes through the executor.
 */
export function toolForAction(
  surface: Surface,
  action: ActionId,
  itemId: string | null,
): ToolCallSpec | null {
  const def = DEFINITIONS[surface.type] as SurfaceDefinition<SurfaceType>;
  const parsed = PAYLOADS[surface.type].safeParse(surface.payload);
  if (!parsed.success || !def.tool) return null;
  if (!surface.actions.some((a) => a.id === action && a.kind === "tool")) return null;
  return def.tool(parsed.data as never, action, itemId);
}

// ── Validation (on write and on restore) ─────────────────────────────────────

const envelope = z.object({
  id: text(120),
  handle: z.string().regex(/^S\d{1,4}$/),
  type: z.enum(SURFACE_TYPES),
  title: text(300),
  state: z.enum(SURFACE_STATES),
  priority: z.number().min(0).max(100),
  size: z.enum(SURFACE_SIZES),
  source: z.object({ capability: text(40), label: text(200).nullable() }).nullable(),
  ref: z.object({ resource: text(40), id: text(1000) }).nullable(),
  payload: z.unknown(),
  actions: z
    .array(
      z.object({
        id: z.enum(ACTION_IDS),
        kind: z.enum(["link", "prompt", "tool", "expand", "approval"]),
        href: href.optional(),
      }),
    )
    .max(8),
  intentId: text(100).nullable(),
  transient: z.boolean().optional(),
  turn: z.number().int().min(0),
  createdAt: text(40),
  updatedAt: text(40),
});

export function parseSurface(raw: unknown): Surface | null {
  const e = envelope.safeParse(raw);
  if (!e.success) return null;
  const p = PAYLOADS[e.data.type].safeParse(e.data.payload);
  if (!p.success) return null;
  return { ...(e.data as Surface), payload: p.data };
}

export function isValidPayload(type: SurfaceType, payload: unknown): boolean {
  return PAYLOADS[type].safeParse(payload).success;
}

const intentSchema = z.object({
  id: text(100),
  kind: z.enum(INTENT_KINDS),
  description: text(300),
  startedAt: text(40),
});

/** Stored or remote state → a valid workspace; anything malformed is dropped, never trusted. */
export function parseWorkspace(raw: {
  version?: unknown;
  turn?: unknown;
  intent?: unknown;
  surfaces?: unknown;
  focusId?: unknown;
  nextHandle?: unknown;
}): WorkspaceState {
  const base = emptyWorkspace();
  const surfaces = Array.isArray(raw.surfaces)
    ? raw.surfaces.map(parseSurface).filter((s): s is Surface => s !== null)
    : [];
  const intent = intentSchema.safeParse(raw.intent);
  const int = (v: unknown, d: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d;
  const handles = surfaces.map((s) => Number(s.handle.slice(1)));
  return {
    version: int(raw.version, base.version),
    turn: int(raw.turn, base.turn),
    intent: intent.success ? intent.data : null,
    surfaces,
    focusId:
      typeof raw.focusId === "string" && surfaces.some((s) => s.id === raw.focusId)
        ? raw.focusId
        : null,
    nextHandle: Math.max(int(raw.nextHandle, 1), ...handles.map((h) => h + 1), 1),
  };
}

// ── Deictic context for the model ────────────────────────────────────────────

/**
 * What the user sees, compactly: handles, titles and the ids needed to act on items, never
 * full payloads. "The second email" resolves to item 2 of the visible email Surface.
 */
export function describeWorkspace(state: WorkspaceState, timezone: string): string | null {
  if (!state.surfaces.length) return null;
  const lines = state.surfaces.map((s) => {
    const def = DEFINITIONS[s.type] as SurfaceDefinition<SurfaceType>;
    const flags = [s.id === state.focusId && "focused", s.state !== "ready" && s.state].filter(
      Boolean,
    );
    return `- ${s.handle} ${s.type}${flags.length ? ` [${flags.join(", ")}]` : ""} ${q(s.title)}: ${def.describe(s.payload as never, timezone)}`;
  });
  return [
    state.intent ? `Active intent: ${state.intent.kind} — ${q(state.intent.description)}` : null,
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}
