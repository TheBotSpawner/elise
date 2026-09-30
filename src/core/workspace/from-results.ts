import {
  isSafeHref,
  surfaceId,
  type IntentKind,
  type SurfaceDraft,
  type SurfaceType,
  type WorkspaceOp,
  type WorkspaceState,
} from "./model";
import { draftDefaults, isValidPayload, type SurfacePayloads } from "./registry";
import type { KnowledgeEvidence, ToolDisplay } from "../agents/tools";
import type { CalendarEvent } from "../capabilities/calendar";
import type { EmailMessage } from "../capabilities/email";
import type { Task } from "../capabilities/tasks";

/**
 * Tool results → Surfaces, deterministically (ADR-013 §5). The application presents what ELISE
 * fetched; the model only decides focus, dismissal and summaries. Only the fields a Surface
 * renders are kept: bodies, raw provider payloads and scores never enter a Surface.
 */

/** Any tool outcome with what a Surface needs: live from the executor or stored in history. */
export type PresentableOutcome =
  | { status: "succeeded"; display?: ToolDisplay }
  | {
      status: "approval_required";
      approvalId: string;
      summary: string;
      reason: string;
      preview?: ToolDisplay;
    }
  | { status: "clarification_required" | "rejected" | "failed" };

export interface PresentOptions {
  /** Stable key for list-like results (the call id, or an orchestration role). */
  key: string;
  intentId?: string | null;
  priority?: number;
  title?: string;
}

const clip = (s: string | null | undefined, n: number) =>
  !s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s;
const safe = (url: string | null | undefined) => (url && isSafeHref(url) ? url : null);
/** Largest stored `result` display; bigger ones stay as inline cards in the thread. */
const MAX_RESULT_BYTES = 24_000;

function draft<K extends SurfaceType>(
  type: K,
  key: string,
  payload: SurfacePayloads[K],
  opts: PresentOptions,
  extra: Partial<SurfaceDraft> & Pick<SurfaceDraft, "title" | "source" | "ref">,
): SurfaceDraft | null {
  if (!isValidPayload(type, payload)) return null;
  const d = draftDefaults(type, payload);
  return {
    id: surfaceId(type, key),
    type,
    state: "ready",
    payload,
    intentId: opts.intentId ?? null,
    ...d,
    ...extra,
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    ...(opts.title ? { title: opts.title } : {}),
  };
}

export function eventPayload(e: CalendarEvent): SurfacePayloads["meeting"] {
  return {
    eventId: e.id,
    title: clip(e.title, 300),
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    status: e.status,
    location: e.location ? clip(e.location, 500) : null,
    description: e.description
      ? clip(
          e.description
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
          800,
        )
      : null,
    calendarName: clip(e.calendarName, 200),
    account: clip(e.provenance.source, 200),
    htmlUrl: safe(e.url),
    meetingUrl: safe(e.meetingUrl),
    attendees: e.attendees.slice(0, 25).map((a) => ({
      name: a.name ? clip(a.name, 200) : null,
      email: clip(a.email, 320),
      response: a.response,
      organizer: a.organizer,
      self: a.self,
    })),
  };
}

export function eventSurface(
  e: CalendarEvent,
  opts: PresentOptions,
  type: "meeting" | "calendar_event" = "calendar_event",
) {
  return draft(type, e.id, eventPayload(e), opts, {
    title: e.title,
    source: { capability: "calendar", label: e.provenance.source },
    ref: { resource: "calendar_event", id: e.id },
  });
}

function emailItem(
  m: EmailMessage,
  needsReply?: boolean,
): SurfacePayloads["email_list"]["items"][number] {
  return {
    messageId: m.id,
    threadId: m.threadId,
    subject: clip(m.subject || "(no subject)", 300),
    from: m.from
      ? { name: m.from.name ? clip(m.from.name, 200) : null, email: clip(m.from.email, 320) }
      : null,
    date: m.date,
    snippet: clip(m.snippet, 300),
    unread: m.unread,
    ...(needsReply !== undefined ? { needsReply } : {}),
    account: clip(m.provenance.source, 200),
  };
}

/** One entry per thread (newest message), newest first. */
export function emailListSurface(
  messages: EmailMessage[],
  opts: PresentOptions & { query?: string },
) {
  const byThread = new Map<string, EmailMessage>();
  for (const m of [...messages].sort((a, b) => b.date.localeCompare(a.date)))
    if (!byThread.has(m.threadId)) byThread.set(m.threadId, m);
  const items = [...byThread.values()].slice(0, 8).map((m) => emailItem(m));
  if (!items.length) return null;
  return draft(
    "email_list",
    opts.key,
    { items, ...(opts.query ? { query: clip(opts.query, 200) } : {}) },
    opts,
    {
      title: opts.title ?? opts.query ?? "",
      source: { capability: "email", label: [...new Set(items.map((i) => i.account))].join(", ") },
      ref: null,
    },
  );
}

export function taskItem(t: Task): SurfacePayloads["task_list"]["items"][number] {
  return {
    id: t.id,
    title: clip(t.title, 300),
    status: t.status,
    dueDate: t.dueDate,
    priority: t.priority,
    source: clip(t.provenance.source, 200),
    listName: t.provenance.listName ? clip(t.provenance.listName, 200) : null,
  };
}

export function taskListSurface(tasks: Task[], opts: PresentOptions) {
  if (!tasks.length) return null;
  const items = tasks.slice(0, 12).map(taskItem);
  return draft("task_list", opts.key, { items, total: tasks.length }, opts, {
    title: opts.title ?? "",
    source: { capability: "tasks", label: [...new Set(items.map((i) => i.source))].join(", ") },
    ref: null,
  });
}

/** Evidence grouped by document, best passages first; one document is a Source Surface. */
export function knowledgeSurface(
  evidence: KnowledgeEvidence[],
  enough: boolean,
  opts: PresentOptions & { query?: string },
) {
  if (!enough || !evidence.length) return null;
  const byItem = new Map<string, KnowledgeEvidence[]>();
  for (const e of evidence) byItem.set(e.itemId, [...(byItem.get(e.itemId) ?? []), e]);
  const sources = [...byItem.values()].slice(0, 6).map((list) => ({
    itemId: list[0]!.itemId,
    title: clip(list[0]!.title, 300),
    sourceType: clip(list[0]!.sourceType, 40),
    spaceName: clip(list[0]!.spaceName, 200),
    url: safe(list[0]!.url),
    passages: list.slice(0, 4).map((e) => ({
      ref: e.ref,
      chunkId: e.chunkId,
      section: e.section ? clip(e.section, 300) : null,
      page: e.page,
      excerpt: clip(e.snippet, 600),
    })),
  }));
  const source = {
    capability: "knowledge",
    label: [...new Set(sources.map((s) => s.spaceName))].join(", "),
  };
  if (sources.length === 1) {
    const only = sources[0]!;
    return draft("knowledge_source", only.itemId, only, opts, {
      title: only.title,
      source,
      ref: { resource: "knowledge_item", id: only.itemId },
    });
  }
  return draft(
    "knowledge_result",
    opts.key,
    { enough, sources, ...(opts.query ? { query: clip(opts.query, 300) } : {}) },
    opts,
    { title: opts.title ?? opts.query ?? "", source, ref: null },
  );
}

type Display<K extends ToolDisplay["kind"]> = Extract<ToolDisplay, { kind: K }>;

function recallSurface(d: Display<"recall_results">, opts: PresentOptions) {
  if (!d.results.length) return null;
  return draft(
    "recall",
    opts.key,
    {
      query: clip(d.query, 300),
      results: d.results.slice(0, 5).map((r) => ({
        interactionId: r.interactionId,
        title: clip(r.title, 300),
        date: r.date,
        summary: r.summary ? clip(r.summary, 1200) : null,
        excerpts: r.excerpts.slice(0, 2).map((e) => ({ text: clip(e.text, 500), at: e.at })),
        url: safe(r.url),
      })),
    },
    opts,
    { title: opts.title ?? d.query, source: { capability: "history", label: null }, ref: null },
  );
}

function settingsSurface(changes: SurfacePayloads["settings"]["changes"], opts: PresentOptions) {
  if (!changes.length) return null;
  // One confirmation per setting: a new change (or Undo) replaces the previous one in place.
  return draft(
    "settings",
    `settings:${changes.map((c) => c.setting).join(",")}`,
    { changes },
    opts,
    {
      title: "",
      source: { capability: "settings", label: null },
      ref: { resource: "settings", id: changes.map((c) => c.setting).join(",") },
      transient: true,
    },
  );
}

function threadSurface(d: Display<"email_thread">, opts: PresentOptions) {
  const t = d.thread;
  const last = t.messages.at(-1);
  const names = [
    ...new Set(
      t.messages.map((m) => m.from?.name ?? m.from?.email).filter((x): x is string => Boolean(x)),
    ),
  ];
  return draft(
    "email_thread",
    t.id,
    {
      threadId: t.id,
      subject: clip(t.subject || "(no subject)", 300),
      participants: names.slice(0, 10).map((n) => clip(n, 200)),
      messageCount: t.messages.length,
      latest: last
        ? {
            from: clip(last.from?.name ?? last.from?.email ?? "?", 200),
            date: last.date,
            // Untrusted text, shown as text only; the full thread loads when opened.
            excerpt: clip((last.body ?? last.snippet).replace(/\s+/g, " ").trim(), 700),
          }
        : null,
      url: safe(t.url),
      account: clip(t.provenance.source, 200),
    },
    opts,
    {
      title: t.subject,
      source: { capability: "email", label: t.provenance.source },
      ref: { resource: "email_thread", id: t.id },
    },
  );
}

function resultSurface(display: ToolDisplay, opts: PresentOptions, capability: string) {
  if (JSON.stringify(display).length > MAX_RESULT_BYTES) return null;
  return draft("result", opts.key, { display }, opts, {
    title: opts.title ?? "",
    source: { capability, label: null },
    ref: null,
  });
}

/** Surfaces for one tool outcome (approvals included). Empty results make no Surface. */
export function surfacesFromOutcome(
  toolName: string,
  outcome: PresentableOutcome,
  opts: PresentOptions,
): SurfaceDraft[] {
  const capability = toolName.split(".")[0] ?? "general";
  if (outcome.status === "approval_required") {
    const s = draft(
      "approval",
      outcome.approvalId,
      {
        approvalId: outcome.approvalId,
        summary: clip(outcome.summary, 500),
        reason: outcome.reason,
        tool: toolName,
        ...(outcome.preview ? { preview: outcome.preview } : {}),
        decision: null,
      },
      opts,
      {
        title: outcome.summary,
        source: { capability, label: null },
        ref: { resource: "approval", id: outcome.approvalId },
        state: "attention",
      },
    );
    return s ? [s] : [];
  }
  if (outcome.status !== "succeeded" || !outcome.display) return [];
  const one = (s: SurfaceDraft | null) => (s ? [s] : []);
  const d = outcome.display;
  switch (d.kind) {
    case "event":
      return d.change === "deleted"
        ? one(resultSurface(d, opts, capability))
        : one(eventSurface(d.event, opts));
    case "event_list":
      return d.events.length === 1
        ? one(eventSurface(d.events[0]!, opts))
        : one(resultSurface(d, opts, capability));
    case "email_list":
      return one(emailListSurface(d.messages, opts));
    case "email_thread":
      return one(threadSurface(d, opts));
    case "email_followups": {
      const items = d.items.slice(0, 8).map((f) => ({
        messageId: f.lastMessageId,
        threadId: f.threadId,
        subject: clip(f.subject, 300),
        from: { name: clip(f.counterpart, 200), email: "" },
        date: f.lastMessageAt,
        snippet: clip(f.snippet, 300),
        unread: false,
        needsReply: d.followUp === "needs_reply",
        account: clip(f.source, 200),
      }));
      return items.length
        ? one(
            draft("email_list", opts.key, { items }, opts, {
              title: opts.title ?? "",
              source: { capability: "email", label: null },
              ref: null,
            }),
          )
        : [];
    }
    case "task_list":
      return one(taskListSurface(d.tasks, opts));
    case "task":
      return one(
        draft("task", d.task.id, { task: taskItem(d.task), change: d.change }, opts, {
          title: d.task.title,
          source: { capability: "tasks", label: d.task.provenance.source },
          ref: { resource: "task", id: d.task.id },
        }),
      );
    case "knowledge_evidence":
      return one(knowledgeSurface(d.evidence, d.enough, opts));
    case "knowledge_document":
      return one(
        draft("document", d.document.itemId, { ...d.document, url: safe(d.document.url) }, opts, {
          title: d.document.title,
          source: { capability: "knowledge", label: d.document.spaceName },
          ref: { resource: "knowledge_item", id: d.document.itemId },
        }),
      );
    case "recall_results":
      return one(recallSurface(d, opts));
    case "appearance": {
      const p = d.previous;
      const changes = [
        ...(p && p.accent !== d.accent
          ? [{ setting: "accent" as const, from: p.accent, to: d.accent }]
          : []),
        ...(p && p.theme !== d.theme
          ? [{ setting: "theme" as const, from: p.theme, to: d.theme }]
          : []),
      ];
      return one(settingsSurface(changes, opts));
    }
    case "setting_changed":
      return one(settingsSurface(d.changes, opts));
    case "schedule_proposal":
      return one(
        draft(
          "schedule",
          opts.key,
          {
            name: clip(d.input.name, 200),
            status: "proposed",
            nextRunAt: d.nextRunAt,
            proposal: d,
          },
          opts,
          { title: d.input.name, source: { capability: "schedules", label: null }, ref: null },
        ),
      );
    default:
      return one(resultSurface(d, opts, capability));
  }
}

/** Ops that present these Surfaces, in order. */
export function presentOps(drafts: SurfaceDraft[], at: string): WorkspaceOp[] {
  return drafts.map((surface) => ({ op: "present", surface, at }));
}

/**
 * A change to a task (from chat or from a Surface action) is reflected wherever that task is
 * visible, so "complete those two tasks" updates the Open Items the user is looking at.
 */
export function reconcileOps(
  state: WorkspaceState,
  outcome: PresentableOutcome,
  at: string,
): WorkspaceOp[] {
  if (outcome.status !== "succeeded" || outcome.display?.kind !== "task") return [];
  const task = taskItem(outcome.display.task);
  const deleted = outcome.display.change === "deleted";
  return state.surfaces.flatMap((s): WorkspaceOp[] => {
    if (s.type !== "task_list") return [];
    const p = s.payload as SurfacePayloads["task_list"];
    if (!p.items.some((i) => i.id === task.id)) return [];
    const items = deleted
      ? p.items.filter((i) => i.id !== task.id)
      : p.items.map((i) => (i.id === task.id ? task : i));
    return [{ op: "update", id: s.id, patch: { payload: { ...p, items } }, at }];
  });
}

/** Approval decided (here, in another tab or in the Approval Center). */
/** Approved tools whose work continues in the background (their Surface shows it). */
const BACKGROUND_TOOLS = new Set(["structured.bulkUpdate"]);

export function approvalDecidedOps(
  state: WorkspaceState,
  approvalId: string,
  decision: "approved" | "rejected",
  display: ToolDisplay | undefined,
  at: string,
): WorkspaceOp[] {
  return state.surfaces
    .filter(
      (s) =>
        s.type === "approval" &&
        (s.payload as SurfacePayloads["approval"]).approvalId === approvalId,
    )
    .map((s) => {
      const p = s.payload as SurfacePayloads["approval"];
      const background = decision === "approved" && BACKGROUND_TOOLS.has(p.tool) && !p.background;
      return {
        op: "update" as const,
        id: s.id,
        patch: {
          state: background ? ("loading" as const) : ("ready" as const),
          payload: {
            ...p,
            decision,
            ...(display ? { display } : {}),
            ...(background ? { background: "running" as const } : {}),
          },
        },
        at,
      };
    });
}

const INTENT_BY_CAPABILITY: Record<string, IntentKind> = {
  meeting: "meeting_prep",
  history: "recall",
  knowledge: "research",
  email: "communication",
  calendar: "planning",
  tasks: "planning",
  habits: "planning",
  goals: "planning",
  lists: "planning",
  notes: "planning",
  settings: "settings",
  appearance: "settings",
  notifications: "settings",
  schedules: "settings",
  connections: "settings",
};

/** Lightweight intent inferred from the first tool of a request (ui.* tools imply none). */
export function intentForTool(toolName: string): IntentKind | null {
  const prefix = toolName.split(".")[0] ?? "";
  if (prefix === "ui") return null;
  return INTENT_BY_CAPABILITY[prefix] ?? "general";
}
