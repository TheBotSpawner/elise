import { z } from "zod";

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
import { TASK_STATUSES } from "../capabilities/tasks";
import { CONTEXT_KINDS, LINK_TYPES } from "../contexts/model";
import { toLocalDateTime } from "../time";

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
          // Room for a markdown source link ([site](url)), rendered as a safe link.
          items: z.array(text(600)).min(1).max(8),
        }),
      )
      .min(1)
      .max(7),
  }),
  web_results: z.object({
    query: text(300),
    retrievedAt: text(40),
    results: z
      .array(
        z.object({
          title: text(300),
          url: href,
          domain: text(200),
          snippet: text(400),
          publishedAt: text(40).nullable(),
          inspected: z.boolean(),
          passages: z.array(text(700)).max(3),
        }),
      )
      .max(8),
  }),
  web_source: z.object({
    url: href,
    title: text(300),
    domain: text(200),
    siteName: text(200).nullable(),
    publishedAt: text(40).nullable(),
    retrievedAt: text(40),
    passages: z.array(text(700)).max(3),
    truncated: z.boolean(),
  }),
  web_news: z.object({
    query: text(200),
    recency: z.enum(["day", "week", "month", "year"]),
    retrievedAt: text(40),
    events: z
      .array(
        z.object({
          headline: text(300),
          items: z
            .array(
              z.object({
                title: text(300),
                url: href,
                domain: text(200),
                publishedAt: text(40).nullable(),
                snippet: text(300),
              }),
            )
            .min(1)
            .max(4),
        }),
      )
      .max(6),
  }),
  web_research: z.object({
    question: text(300),
    retrievedAt: text(40),
    subquestions: z
      .array(
        z.object({
          question: text(200),
          status: z.enum(["searching", "done", "gap", "failed"]),
          sources: z
            .array(
              z.object({
                title: text(200),
                url: href,
                domain: text(200),
                publishedAt: text(40).nullable(),
                inspected: z.boolean(),
              }),
            )
            .max(4),
        }),
      )
      .max(4),
  }),
  // ── Contexts, Work and Study (ADR-016) ──
  context_overview: z.object({
    contextId: text(100),
    name: text(120),
    kind: z.enum(CONTEXT_KINDS),
    accent: text(20).nullable(),
    description: text(400).nullable(),
    links: z.array(z.object({ type: text(40), label: text(200), confirmed: z.boolean() })).max(16),
    /** A brief's comparison point ("since your last RSFA interaction on Sep 28"). */
    baseline: z
      .object({
        since: text(40),
        basis: z.enum(["user", "last_interaction", "last_meeting", "default_window"]),
      })
      .nullable(),
    /** What each source contributed, or that it was unavailable. */
    sources: z
      .array(
        z.object({
          source: text(30),
          status: z.enum(["ok", "empty", "unavailable", "failed"]),
          count: z.number().int().min(0),
        }),
      )
      .max(10),
  }),
  context_proposal: z.object({
    name: text(80),
    kind: z.enum(CONTEXT_KINDS),
    description: text(400).nullable(),
    aliases: z.array(text(80)).max(12),
    suggestions: z
      .array(
        z.object({
          id: text(20),
          type: z.enum(LINK_TYPES),
          resourceId: text(600).nullable(),
          value: text(320).nullable(),
          label: text(200),
          detail: text(200).nullable(),
          confidence: z.enum(["high", "medium", "low"]),
          person: z.object({ name: text(200), email: text(320) }).nullable(),
        }),
      )
      .max(16),
    /** Set once the user created it from this proposal. */
    createdId: text(100).nullable(),
  }),
  commitments: z.object({
    contextName: text(120),
    items: z
      .array(
        z.object({
          id: text(20),
          text: text(240),
          direction: z.enum(["ours", "theirs", "waiting"]),
          who: text(200).nullable(),
          source: z.object({
            kind: z.enum(["email", "recall", "task"]),
            label: text(200),
            date: text(40).nullable(),
            ref: text(1000).nullable(),
          }),
        }),
      )
      .max(8),
  }),
  timeline: z.object({
    contextName: text(120),
    entries: z
      .array(
        z.object({
          at: text(40),
          kind: z.enum(["meeting", "email", "task", "document", "interaction", "record"]),
          title: text(300),
          detail: text(200).nullable(),
          upcoming: z.boolean(),
        }),
      )
      .max(12),
  }),
  study_question: z.object({
    sessionId: text(100),
    contextName: text(120),
    mode: z.enum(["review", "oral_exam", "quiz"]),
    number: z.number().int().min(1),
    question: text(600),
    conceptLabel: text(120),
    options: z.array(text(200)).max(4).nullable(),
    /** Hints shown so far (never the ones not asked for). */
    hints: z.array(text(240)).max(3),
    state: z.enum(["asking", "answered"]),
    /** Shown after the answer only, when feedback is per answer. */
    assessment: z.enum(["strong", "partial", "needs_review"]).nullable(),
    feedback: z
      .object({
        correct: z.array(text(240)).max(5),
        missing: z.array(text(240)).max(5),
        incorrect: z.array(text(240)).max(5),
        explanation: text(800),
      })
      .nullable(),
    /** Excerpts of the material: empty until answered or asked for. */
    sources: z
      .array(
        z.object({
          itemId: text(100),
          title: text(300),
          section: text(300).nullable(),
          page: z.number().int().nullable(),
          excerpt: text(600),
        }),
      )
      .max(3),
    /** The answer just given, with its feedback (when feedback is per answer). */
    previous: z
      .object({
        number: z.number().int().min(1),
        question: text(600),
        answer: text(400),
        assessment: z.enum(["strong", "partial", "needs_review"]).nullable(),
        feedback: z
          .object({
            correct: z.array(text(240)).max(5),
            missing: z.array(text(240)).max(5),
            incorrect: z.array(text(240)).max(5),
            explanation: text(800),
          })
          .nullable(),
        sources: z
          .array(
            z.object({
              itemId: text(100),
              title: text(300),
              section: text(300).nullable(),
              page: z.number().int().nullable(),
              excerpt: text(600),
            }),
          )
          .max(3),
      })
      .nullable(),
    feedbackMode: z.enum(["each", "end"]),
    scope: text(200),
  }),
  study_progress: z.object({
    contextId: text(100),
    contextName: text(120),
    counts: z.object({
      not_reviewed: z.number().int().min(0),
      learning: z.number().int().min(0),
      understood: z.number().int().min(0),
      needs_review: z.number().int().min(0),
    }),
    weak: z.array(text(120)).max(6),
    strong: z.array(text(120)).max(6),
    sessionQuestions: z.number().int().min(0),
    targetDate: text(10).nullable(),
  }),
  study_summary: z.object({
    contextName: text(120),
    questions: z.number().int().min(0),
    covered: z.array(text(120)).max(20),
    strong: z.array(text(120)).max(20),
    review: z.array(text(120)).max(20),
    mistakes: z.array(text(240)).max(5),
    nextReview: z.array(text(120)).max(5),
    at: text(40),
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
  web_results: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 62,
    actions: () => [expand],
    describe: (p) =>
      p.results.map((r, i) => `${i + 1}) ${q(r.title)} · ${r.domain} (${r.url})`).join("; "),
  },
  web_source: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 64,
    actions: (p) => [...link("open", p.url), { id: "save", kind: "prompt" }, expand],
    describe: (p) => `${q(p.title)} · ${p.domain} (${p.url})`,
  },
  web_news: {
    sizes: ["small", "medium", "large", "expanded"],
    size: "medium",
    priority: 63,
    actions: () => [expand],
    describe: (p) =>
      p.events
        .map(
          (e, i) =>
            `${i + 1}) ${q(e.headline)} — ${e.items.map((it) => it.domain).join(", ")} (${e.items[0]?.url})`,
        )
        .join("; "),
  },
  web_research: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 80,
    actions: () => [expand],
    describe: (p) =>
      p.subquestions
        .map(
          (s, i) =>
            `${i + 1}) ${q(s.question)} [${s.status}]: ${s.sources.map((x) => x.url).join(" ")}`,
        )
        .join("; "),
  },
  context_overview: {
    sizes: ["small", "medium", "large"],
    size: "medium",
    priority: 85,
    actions: (p) => [
      { id: "open", kind: "link", href: `/my-elise/contexts/${p.contextId}` },
      { id: "research", kind: "prompt" },
    ],
    describe: (p) =>
      `${q(p.name)} (${p.kind}, context ${p.contextId})${p.baseline ? ` since ${p.baseline.since.slice(0, 10)} [${p.baseline.basis}]` : ""}${p.sources.length ? ` · sources: ${p.sources.map((s) => `${s.source} ${s.status}${s.count ? ` ${s.count}` : ""}`).join(", ")}` : ""}`,
  },
  context_proposal: {
    sizes: ["medium", "large"],
    size: "large",
    priority: 92,
    actions: (p) => (p.createdId ? [] : [{ id: "create_context", kind: "tool" }]),
    describe: (p) =>
      `Proposed context ${q(p.name)} (${p.kind})${p.createdId ? " [created]" : ""}: ${p.suggestions.map((s) => `${s.id}) ${s.label} [${s.confidence}]`).join("; ")}`,
    // The user's selection (suggestion ids) arrives as itemId; everything else comes from the
    // stored proposal, never from the browser.
    tool: (p, action, itemId) => {
      if (action !== "create_context" || p.createdId) return null;
      const chosen = new Set((itemId ?? "").split(",").filter(Boolean));
      return {
        name: "contexts.create",
        args: {
          kind: p.kind,
          name: p.name,
          ...(p.description ? { description: p.description } : {}),
          aliases: p.aliases,
          links: p.suggestions
            .filter((s) => chosen.has(s.id))
            .map((s) => ({
              type: s.type,
              ...(s.resourceId ? { resourceId: s.resourceId } : {}),
              ...(s.value ? { value: s.value } : {}),
              label: s.label,
              ...(s.person ? { person: s.person } : {}),
            })),
        },
      };
    },
  },
  commitments: {
    sizes: ["small", "medium", "large"],
    size: "medium",
    priority: 72,
    actions: (p) => (p.items.length ? [{ id: "create_task", kind: "tool" }] : []),
    describe: (p) =>
      p.items
        .map(
          (c, i) =>
            `${i + 1}) [${c.direction}] ${q(c.text)}${c.who ? ` — ${c.who}` : ""} (${c.source.kind} ${q(c.source.label)}${c.source.date ? ` ${c.source.date.slice(0, 10)}` : ""}, item ${c.id})`,
        )
        .join("; "),
    tool: (p, action, itemId) => {
      const item = p.items.find((c) => c.id === itemId);
      return action === "create_task" && item
        ? { name: "tasks.create", args: { title: item.text.slice(0, 200) } }
        : null;
    },
  },
  timeline: {
    sizes: ["small", "medium", "large"],
    size: "medium",
    priority: 62,
    actions: () => [expand],
    describe: (p, tz) =>
      p.entries
        .map(
          (e) =>
            `${local(e.at, tz).slice(0, 10)} ${e.kind}${e.upcoming ? " (upcoming)" : ""} ${q(e.title)}`,
        )
        .join("; "),
  },
  study_question: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 96,
    actions: (p) =>
      p.state === "asking"
        ? [
            ...(p.hints.length < 3 ? [{ id: "hint" as const, kind: "tool" as const }] : []),
            ...(p.sources.length ? [] : [{ id: "reveal" as const, kind: "tool" as const }]),
            { id: "next", kind: "tool" },
            { id: "end_session", kind: "tool" },
          ]
        : [
            { id: "next", kind: "tool" },
            { id: "end_session", kind: "tool" },
          ],
    // The model gets the question, never the key points or hints it hasn't shown.
    describe: (p) =>
      `Study session ${p.sessionId} · ${q(p.contextName)} · ${p.mode} · question ${p.number} [${p.state}${p.assessment ? `: ${p.assessment}` : ""}] about ${q(p.conceptLabel)}: ${q(p.question)}`,
    tool: (p, action) => {
      const session = { session: p.sessionId };
      switch (action) {
        case "hint":
          return p.state === "asking" ? { name: "study.hint", args: session } : null;
        case "reveal":
          return p.state === "asking" ? { name: "study.reveal", args: session } : null;
        case "next":
          return { name: "study.next", args: session };
        case "end_session":
          return { name: "study.end", args: session };
        default:
          return null;
      }
    },
  },
  study_progress: {
    sizes: ["small", "medium"],
    size: "small",
    priority: 70,
    actions: (p) => (p.weak.length ? [{ id: "review_weak", kind: "prompt" }] : []),
    describe: (p) =>
      `${q(p.contextName)} progress: understood ${p.counts.understood}, learning ${p.counts.learning}, needs review ${p.counts.needs_review}, not reviewed ${p.counts.not_reviewed}${p.weak.length ? ` · weak: ${p.weak.join(", ")}` : ""}`,
  },
  study_summary: {
    sizes: ["medium", "large", "expanded"],
    size: "large",
    priority: 94,
    actions: (p) => (p.review.length ? [{ id: "review_weak", kind: "prompt" }] : []),
    describe: (p) =>
      `${q(p.contextName)} session summary: ${p.questions} questions · strong: ${p.strong.join(", ") || "—"} · review: ${p.review.join(", ") || "—"}`,
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

const contextSchema = z.object({
  id: text(100),
  name: text(120),
  kind: z.enum(CONTEXT_KINDS),
  accent: text(20).nullable(),
  turn: z.number().int().min(0),
});

/** Stored or remote state → a valid workspace; anything malformed is dropped, never trusted. */
export function parseWorkspace(raw: {
  version?: unknown;
  turn?: unknown;
  intent?: unknown;
  surfaces?: unknown;
  focusId?: unknown;
  nextHandle?: unknown;
  context?: unknown;
}): WorkspaceState {
  const base = emptyWorkspace();
  const surfaces = Array.isArray(raw.surfaces)
    ? raw.surfaces.map(parseSurface).filter((s): s is Surface => s !== null)
    : [];
  const intent = intentSchema.safeParse(raw.intent);
  const context = contextSchema.safeParse(raw.context);
  const int = (v: unknown, d: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : d;
  const handles = surfaces.map((s) => Number(s.handle.slice(1)));
  return {
    version: int(raw.version, base.version),
    turn: int(raw.turn, base.turn),
    intent: intent.success ? intent.data : null,
    context: context.success ? context.data : null,
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
    state.context ? `Active context: ${q(state.context.name)} (${state.context.kind})` : null,
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}
