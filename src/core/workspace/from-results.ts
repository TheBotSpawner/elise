import { clipText } from "../text";
import { calendarPayload } from "./calendar";
import {
  isSafeHref,
  surfaceId,
  type IntentKind,
  type SurfaceDraft,
  type SurfaceType,
  type WorkspaceOp,
  type WorkspaceState,
} from "./model";
import { MUSIC_SURFACE_KEY } from "./music";
import { draftDefaults, isValidPayload, type SurfacePayloads } from "./registry";
import {
  budgetsVisual,
  financeBreakdownVisual,
  financeSummaryVisuals,
  habitStatsVisuals,
  habitsVisual,
  type BuiltVisualization,
  type VizLocale,
} from "./visualization";
import type { KnowledgeEvidence, ToolDisplay } from "../agents/tools";
import type { CalendarEvent } from "../capabilities/calendar";
import type { EmailMessage } from "../capabilities/email";
import type { EmailTriageGroup } from "../capabilities/email-triage";
import { splitItems } from "../capabilities/lists";
import type { Task } from "../capabilities/tasks";
import { channelLabel, type TeamMessage } from "../capabilities/team-messaging";
import { goalCard, goalsSummary } from "../goals/analytics";
import { analysisVisuals } from "../structured/analysis";
import { todayIn } from "../time";

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
  /** The user's language, for the few words derived charts carry (ADR-021). */
  locale?: VizLocale;
  /** The user's timezone: calendars place events in the user's days (ADR-033). */
  timezone?: string;
}

const clip = clipText;
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

/**
 * Triaged email (ADR-067): one Communication Surface per account, never one mixed list. Its id
 * comes from the account, so refreshing the read updates each account's Surface in place.
 */
export function triageSurfaces(
  messages: EmailMessage[],
  groups: EmailTriageGroup[],
  opts: PresentOptions,
): SurfaceDraft[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return groups.flatMap((g) => {
    const items = g.items.flatMap((t) => {
      const m = byId.get(t.messageId);
      return m
        ? [
            {
              ...emailItem(m, t.status === "needs_reply"),
              priority: t.level,
              status: t.status,
            },
          ]
        : [];
    });
    if (!items.length) return [];
    const label = clip(g.account.label, 200);
    const s = draft(
      "email_list",
      `${opts.key}:${g.account.connectionId}`,
      {
        items: items.slice(0, 10),
        mailbox: {
          label,
          providerKey: g.account.providerKey,
          address: g.account.address ? clip(g.account.address, 320) : null,
        },
      },
      opts,
      { title: label, source: { capability: "email", label }, ref: null },
    );
    return s ? [s] : [];
  });
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
    ...(t.labels?.length ? { labels: t.labels.slice(0, 10).map((l) => clip(l, 60)) } : {}),
    ...(t.parentId ? { subtask: true } : {}),
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

/**
 * After the answer (ADR-114): the documents card keeps only the documents the answer cited
 * ("[2]"). Asked for one article and cited only it → one article card, not every match the
 * search found. Null when nothing changes (no citations, or all sources were cited).
 */
export function citedKnowledge<P extends { sources: { passages: { ref: number }[] }[] }>(
  payload: P,
  answer: string,
): P | null {
  const refs = new Set([...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])));
  if (!refs.size) return null;
  const sources = payload.sources.filter((s) => s.passages.some((p) => refs.has(p.ref)));
  if (!sources.length || sources.length === payload.sources.length) return null;
  return { ...payload, sources };
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
        // Matched by its words: the card shows the exchange itself, not a general summary.
        summary: r.summary && !r.relevance.keyword ? clip(r.summary, 1200) : null,
        excerpts: r.excerpts.slice(0, 2).map((e) => ({ text: clip(e.text, 500), at: e.at })),
        url: safe(r.url),
        modality: r.modality,
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

/** Fixed keys: one results and one thread Surface per interaction, updated in place (ADR-062). */
export const TEAM_RESULTS_KEY = "team_messaging:results";
export const TEAM_THREAD_KEY = "team_messaging:thread";
export const TEAM_DRAFT_KEY = "team_messaging:draft";

const oneLine = (s: string, max: number) => clip(s.replace(/\s+/g, " ").trim(), max);

function teamItem(m: TeamMessage): SurfacePayloads["team_messages"]["items"][number] {
  return {
    messageId: m.id,
    threadId: m.threadId,
    channel: clip(channelLabel(m.channel), 200),
    author: clip(m.author.name, 200),
    date: m.date,
    text: oneLine(m.text, 800),
    replyCount: m.replyCount,
    url: safe(m.url),
    workspace: clip(m.provenance.source, 200),
  };
}

/**
 * A search (or a channel's window) is one Surface the next search replaces — even when it finds
 * nothing, so an outdated result never stays on screen as if it answered the new question.
 */
function teamMessagesSurface(d: Display<"team_messages">, opts: PresentOptions) {
  return draft(
    "team_messages",
    TEAM_RESULTS_KEY,
    {
      query: d.query ? clip(d.query, 300) : null,
      channel: d.channel ? clip(d.channel, 200) : null,
      items: d.messages.slice(0, 10).map(teamItem),
      files: d.files.slice(0, 6).map((f) => ({
        title: clip(f.title, 300),
        fileType: f.fileType ? clip(f.fileType, 40) : null,
        url: safe(f.url),
        date: f.date,
        author: f.author ? clip(f.author, 200) : null,
        workspace: clip(f.provenance.source, 200),
      })),
      notSearched: d.notSearched,
      ...(d.unavailable?.length
        ? { unavailable: d.unavailable.slice(0, 10).map((u) => clip(u, 200)) }
        : {}),
      ...(d.unread ? { unread: true } : {}),
    },
    opts,
    {
      title: opts.title ?? d.query ?? d.channel ?? "Slack",
      source: {
        capability: "team_messaging",
        label: [...new Set(d.messages.map((m) => m.provenance.source))].join(", ") || null,
      },
      ref: null,
    },
  );
}

/** The conversation as one Surface: its root and latest replies, never a Surface per message. */
function teamThreadSurface(d: Display<"team_thread">, opts: PresentOptions) {
  const t = d.thread;
  return draft(
    "team_thread",
    TEAM_THREAD_KEY,
    {
      threadId: t.id,
      channel: clip(channelLabel(t.channel), 200),
      workspace: clip(t.provenance.source, 200),
      url: safe(t.url),
      total: t.messages.length,
      hasMore: t.hasMore,
      messages: [...t.messages.slice(0, 1), ...t.messages.slice(1).slice(-29)].map((m) => ({
        messageId: m.id,
        author: clip(m.author.name, 200),
        date: m.date,
        text: oneLine(m.text, 800),
        url: safe(m.url),
      })),
    },
    opts,
    {
      title: channelLabel(t.channel),
      source: { capability: "team_messaging", label: t.provenance.source },
      ref: null,
    },
  );
}

/** The list a result is about; an empty one is nothing worth showing. */
function isEmptyResult(d: ToolDisplay): boolean {
  const lists: unknown[] = [];
  switch (d.kind) {
    case "habits":
      lists.push(d.progress);
      break;
    case "goals":
      lists.push(d.goals);
      break;
    case "notes":
      lists.push(d.notes);
      break;
    case "event_list":
      lists.push(d.events);
      break;
    case "calendars":
      lists.push(d.calendars);
      break;
    case "task_lists":
      lists.push(d.lists);
      break;
    case "finance_transactions":
      lists.push(d.transactions);
      break;
    case "finance_accounts":
      lists.push(d.accounts);
      break;
    case "finance_categories":
      lists.push(d.categories);
      break;
    case "structured_records":
      lists.push(d.records);
      break;
    case "structured_sources":
      lists.push(d.sources);
      break;
    default:
      return false;
  }
  return lists.every((l) => Array.isArray(l) && l.length === 0);
}

function resultSurface(display: ToolDisplay, opts: PresentOptions, capability: string) {
  if (isEmptyResult(display) || JSON.stringify(display).length > MAX_RESULT_BYTES) return null;
  return draft("result", opts.key, { display }, opts, {
    title: opts.title ?? "",
    source: { capability, label: null },
    ref: null,
  });
}

/** A calendar dataset (events or busy/free time) as one Calendar Surface. */
function calendarSurface(
  data: Pick<
    Parameters<typeof calendarPayload>[0],
    "events" | "from" | "to" | "free" | "busy" | "complete"
  >,
  opts: PresentOptions,
) {
  const timezone = opts.timezone ?? "UTC";
  const payload = calendarPayload({ ...data, timezone, today: todayIn(timezone) });
  return draft("calendar", opts.key, payload, opts, {
    title: opts.title ?? "",
    source: { capability: "calendar", label: null },
    ref: null,
    size: payload.view === "day" || payload.view === "agenda" ? "medium" : "large",
  });
}

/** One overview per context: presenting it again (a brief after creation) updates it. */
export function contextOverviewSurface(
  overview: SurfacePayloads["context_overview"],
  opts: PresentOptions,
) {
  return draft("context_overview", overview.contextId, overview, opts, {
    title: overview.name,
    source: { capability: "contexts", label: overview.name },
    ref: { resource: "context_profile", id: overview.contextId },
  });
}

/** How prominent each derived chart is: the headline first, detail after. */
const VIZ_PRIORITY: Record<string, number> = {
  kpi: 76,
  breakdown: 66,
  habits: 66,
  trend: 58,
  goals: 64,
  categories: 62,
  change: 60,
  largest: 48,
};

function visualizationSurface(v: BuiltVisualization, opts: PresentOptions, capability: string) {
  return draft(
    "visualization",
    `${opts.key}:${v.role}`,
    { spec: v.spec },
    { ...opts, priority: opts.priority ?? VIZ_PRIORITY[v.role] ?? 60 },
    {
      title: v.spec.title,
      source: { capability, label: v.spec.source ?? null },
      ref: null,
    },
  );
}

/** Charts from a structured result; when none can be drawn honestly, its usual card. */
function visualsOr(
  built: (BuiltVisualization | null)[],
  display: ToolDisplay,
  opts: PresentOptions,
  capability: string,
): SurfaceDraft[] {
  const drafts = built
    .filter((v): v is BuiltVisualization => v !== null)
    .map((v) => visualizationSurface(v, opts, capability))
    .filter((d): d is SurfaceDraft => d !== null);
  if (drafts.length) return drafts;
  const fallback = resultSurface(display, opts, capability);
  return fallback ? [fallback] : [];
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
    case "event_list": {
      // Calendar data looks like a calendar (ADR-033); one match from a long search is a card.
      const long = Date.parse(d.to) - Date.parse(d.from) > 8 * 86_400_000;
      return d.events.length === 1 && long
        ? one(eventSurface(d.events[0]!, opts))
        : one(
            calendarSurface(
              { events: d.events, from: d.from, to: d.to, complete: d.complete !== false },
              opts,
            ),
          );
    }
    case "availability":
      return one(
        calendarSurface({ events: [], from: d.from, to: d.to, free: d.free, busy: d.busy }, opts),
      );
    case "email_list":
      return d.triage
        ? triageSurfaces(d.messages, d.triage, opts)
        : one(emailListSurface(d.messages, opts));
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
    case "team_messages":
      return one(teamMessagesSurface(d, opts));
    case "team_thread":
      return one(teamThreadSurface(d, opts));
    case "team_draft":
      // One draft card: preparing, then sending, updates it in place.
      return one(resultSurface(d, { ...opts, key: TEAM_DRAFT_KEY }, "team_messaging"));
    // A reaction is a line in the conversation, not a window.
    case "team_reaction":
      return [];
    case "task_list":
      return one(taskListSurface(d.tasks, opts));
    case "native_list": {
      // Keyed by the list: every change to it updates this Surface, never a second window.
      const { active, done } = splitItems(d.list);
      const items = [...active, ...done].slice(0, 60).map((i) => ({
        id: i.id,
        content: clip(i.content, 500),
        checked: i.checked,
        notes: i.notes ? clip(i.notes, 1000) : null,
        ...(i.labels?.length ? { labels: i.labels.slice(0, 10).map((l) => clip(l, 60)) } : {}),
      }));
      return one(
        draft(
          "checklist",
          d.list.id,
          {
            listId: d.list.id,
            name: clip(d.list.name, 120),
            icon: d.list.icon ? clip(d.list.icon, 16) : null,
            items,
            open: active.length,
            total: d.list.items.length,
          },
          opts,
          {
            title: d.list.name,
            source: { capability: "lists", label: null },
            ref: { resource: "list", id: d.list.id },
          },
        ),
      );
    }
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
    case "web_results":
      return d.results.length
        ? one(
            draft(
              "web_results",
              opts.key,
              {
                query: clip(d.query, 300),
                retrievedAt: d.retrievedAt,
                results: d.results
                  .filter((r) => safe(r.url))
                  .slice(0, 8)
                  .map((r) => ({
                    title: clip(r.title || r.domain, 300),
                    url: r.url,
                    domain: clip(r.domain, 200),
                    snippet: clip(r.snippet, 400),
                    publishedAt: r.publishedAt,
                    inspected: r.inspected,
                    passages: r.passages.slice(0, 3).map((p) => clip(p, 700)),
                  })),
              },
              opts,
              {
                title: opts.title ?? d.query,
                source: { capability: "web_search", label: null },
                ref: null,
              },
            ),
          )
        : [];
    case "web_news":
      return d.events.length
        ? one(
            draft(
              "web_news",
              opts.key,
              {
                query: clip(d.query, 200),
                recency: d.recency,
                retrievedAt: d.retrievedAt,
                events: d.events
                  .slice(0, 6)
                  .map((e) => ({
                    headline: clip(e.headline, 300),
                    items: e.items
                      .filter((i) => safe(i.url))
                      .slice(0, 4)
                      .map((i) => ({
                        ...i,
                        title: clip(i.title, 300),
                        domain: clip(i.domain, 200),
                        snippet: clip(i.snippet, 300),
                      })),
                  }))
                  .filter((e) => e.items.length),
              },
              opts,
              {
                title: opts.title ?? d.query,
                source: { capability: "web_search", label: null },
                ref: null,
              },
            ),
          )
        : [];
    case "web_page":
      return safe(d.page.url)
        ? one(
            draft(
              "web_source",
              d.page.url,
              {
                ...d.page,
                title: clip(d.page.title, 300),
                domain: clip(d.page.domain, 200),
                siteName: d.page.siteName ? clip(d.page.siteName, 200) : null,
                passages: d.page.passages.slice(0, 3).map((p) => clip(p, 700)),
              },
              opts,
              {
                title: d.page.title,
                source: { capability: "web_search", label: d.page.siteName ?? d.page.domain },
                ref: { resource: "web_page", id: d.page.url },
              },
            ),
          )
        : [];
    case "web_research":
      return one(
        draft(
          "web_research",
          `${opts.intentId ?? null}:${d.question}`,
          {
            question: clip(d.question, 300),
            retrievedAt: d.retrievedAt,
            subquestions: d.subquestions.slice(0, 4).map((s) => ({
              question: clip(s.question, 200),
              status: s.status,
              sources: s.sources
                .filter((x) => safe(x.url))
                .slice(0, 4)
                .map((x) => ({ ...x, title: clip(x.title, 200), domain: clip(x.domain, 200) })),
            })),
          },
          opts,
          { title: d.question, source: { capability: "web_search", label: null }, ref: null },
        ),
      );
    case "context_profile":
      return one(contextOverviewSurface(d.overview, opts));
    case "context_proposal":
      return one(
        draft("context_proposal", d.proposal.name.toLowerCase(), d.proposal, opts, {
          title: d.proposal.name,
          source: { capability: "contexts", label: null },
          ref: null,
          ...(d.proposal.createdId ? {} : { state: "attention" as const }),
        }),
      );
    case "work_brief":
      return [
        contextOverviewSurface(d.overview, opts),
        d.commitments.items.length
          ? draft("commitments", `${d.overview.contextId}:commitments`, d.commitments, opts, {
              title: d.overview.name,
              source: { capability: "contexts", label: d.overview.name },
              ref: null,
            })
          : null,
        d.timeline.entries.length
          ? draft("timeline", `${d.overview.contextId}:timeline`, d.timeline, opts, {
              title: d.overview.name,
              source: { capability: "contexts", label: d.overview.name },
              ref: null,
            })
          : null,
      ].filter((s): s is SurfaceDraft => s !== null);
    case "map": {
      const m = d.map;
      // A new search or route replaces the map; the locate prompt is one per interaction.
      const key = m.mode === "locate" ? "locate" : m.mode === "route" ? "route" : "places";
      return one(
        draft("map", key, m, opts, {
          title: m.route ? `${m.route.from} → ${m.route.to}` : m.query,
          source: { capability: "location", label: null },
          ref: null,
          ...(m.mode === "locate" ? { state: "attention" as const } : {}),
        }),
      );
    }
    case "place":
      return one(
        draft("place", d.place.id, d.place, opts, {
          title: d.place.name,
          source: { capability: "location", label: d.place.category },
          ref: { resource: "place", id: d.place.id },
        }),
      );
    case "music":
      // One music Surface per interaction: a new song, a pause or a search updates it.
      return one(
        draft("music", MUSIC_SURFACE_KEY, d.music, opts, {
          title: d.music.item?.title ?? (opts.locale === "es" ? "Música" : "Music"),
          source: { capability: "music", label: d.music.provider },
          ref: null,
          ...(d.music.notice ? { state: "attention" as const } : {}),
        }),
      );
    case "timer":
      return one(timerSurface(d.timer, opts));
    case "timers":
      return d.timers
        .map((t) => timerSurface(t, opts))
        .filter((s): s is SurfaceDraft => s !== null);
    case "clock":
      return one(
        draft("clock", d.clock.timezone, d.clock, opts, {
          title: d.clock.place ?? (opts.locale === "es" ? "Reloj" : "Clock"),
          source: { capability: "time", label: null },
          ref: null,
        }),
      );
    case "market": {
      const m = d.market;
      // One quote card per set of symbols; a history per symbol and period updates in place.
      const key =
        m.mode === "history" && m.history
          ? `history:${m.history.symbol}`
          : `${m.mode}:${m.quotes.map((q) => q.symbol).join(",")}`;
      const lead = m.history ?? m.quotes[0];
      return one(
        draft("market", key, m, opts, {
          title:
            m.mode === "watch"
              ? opts.locale === "es"
                ? "Mercados que seguís"
                : "Markets you follow"
              : lead
                ? `${lead.name ?? lead.symbol} · ${lead.symbol}`
                : opts.locale === "es"
                  ? "Mercados"
                  : "Markets",
          // The data provider's code name ("fmp") means nothing to the person: no label.
          source: { capability: "markets", label: null },
          ref: null,
        }),
      );
    }
    case "alarms":
      // One alarms Surface: a new list, a change or the sound picker updates it in place.
      return one(
        draft("alarms", "alarms", d.alarms, opts, {
          title: "",
          source: { capability: "time", label: null },
          ref: null,
        }),
      );
    case "day_plan":
      // One plan per day: every change to that day's proposal updates it, never a second one.
      return one(
        draft("day_plan", `day_plan:${d.plan.date}`, d.plan, opts, {
          title: d.plan.title ?? "",
          source: { capability: "workspace", label: null },
          ref: null,
        }),
      );
    case "economy":
      // One Surface per question kind (rates, the blue's history…): asking again updates it.
      return one(
        draft("economy", d.key, d.economy, opts, {
          title: d.title,
          source: { capability: "economy", label: d.economy.sources[0]?.name ?? null },
          ref: null,
        }),
      );
    case "shopping":
      // One Surface per question (a product, a list's comparison): asking again updates it.
      return one(
        draft("shopping", d.key, d.shopping, opts, {
          title: d.title,
          source: { capability: "shopping", label: "SEPA" },
          ref: null,
        }),
      );
    case "product_offers":
      return one(
        draft("product_offers", d.key, d.offers, opts, {
          title: d.title,
          source: { capability: "shopping", label: d.offers.marketplace.name },
          ref: null,
        }),
      );
    case "home":
      return one(
        draft("home", `home:${d.home.title}`, d.home, opts, {
          title: d.home.title,
          source: { capability: "home", label: null },
          ref: null,
        }),
      );
    case "personality":
      return one(
        draft("personality", "personality", { current: d.current }, opts, {
          title: opts.locale === "es" ? "Personalidad" : "Personality",
          source: { capability: "settings", label: null },
          ref: { resource: "settings", id: "personality" },
        }),
      );
    case "finance_import":
      return one(
        draft("finance_import", d.financeImport.importId, d.financeImport, opts, {
          title: opts.locale === "es" ? "Importación de finanzas" : "Finance import",
          source: { capability: "finance", label: null },
          ref: null,
        }),
      );
    case "image_gallery": {
      // ADR-120: "más fotos de la segunda" updates that subject's gallery; a new question makes
      // its own (keyed by its subjects), so an older gallery never stands in for this one.
      const names = d.gallery.groups.map((g) => g.name);
      return one(
        draft(
          "image_gallery",
          d.key ?? d.gallery.groups.map((g) => g.key).join("+"),
          d.gallery,
          opts,
          {
            title: names.join(" · ").slice(0, 120),
            source: { capability: "web_search", label: null },
            ref: null,
          },
        ),
      );
    }
    case "weather": {
      const w = d.weather;
      // One forecast per interaction: asking again (another day, another city) updates it.
      return one(
        draft("weather", "weather", w, opts, {
          title: w.location?.name ?? (opts.locale === "es" ? "Clima" : "Weather"),
          source: { capability: "weather", label: w.attribution.name },
          ref: null,
          ...(w.mode === "needs_location" ? { state: "attention" as const } : {}),
        }),
      );
    }
    case "study_question":
      return one(
        draft("study_question", d.question.sessionId, d.question, opts, {
          title: d.question.contextName,
          source: { capability: "study", label: d.question.contextName },
          ref: { resource: "study_session", id: d.question.sessionId },
        }),
      );
    case "study_progress":
      return one(
        draft("study_progress", d.progress.contextId, d.progress, opts, {
          title: d.progress.contextName,
          source: { capability: "study", label: d.progress.contextName },
          ref: { resource: "context_profile", id: d.progress.contextId },
        }),
      );
    case "study_summary":
      return one(
        draft("study_summary", `${d.summary.contextName}:${d.summary.at}`, d.summary, opts, {
          title: d.summary.contextName,
          source: { capability: "study", label: d.summary.contextName },
          ref: null,
        }),
      );
    // A brief is presented as its own Surfaces (calendar, tasks, email…) by the session that
    // has it, never as one report-shaped Surface (ADR-041).
    case "morning_brief":
      return [];
    // A Method used or changed is a quiet line in the conversation, never a Surface (ADR-040 §N).
    case "method":
      return [];
    case "shortcut":
      return one(
        draft("shortcut", d.shortcut.name.toLowerCase(), d.shortcut, opts, {
          title: d.shortcut.name,
          source: { capability: "shortcuts", label: null },
          ref: null,
          // A saved confirmation leaves on its own; a proposal waits for Save.
          ...(d.shortcut.state === "saved" ? { transient: true } : { state: "attention" as const }),
        }),
      );
    case "finance_summary":
      return visualsOr(financeSummaryVisuals(d.summary, opts.locale), d, opts, capability);
    case "structured_analysis":
      // One analytical object per database (ADR-048): stable ids, so a follow-up ("solo las
      // activas", "ordenalas por valor") replaces these Surfaces instead of adding cards.
      return visualsOr(
        analysisVisuals(d.analysis, opts.locale),
        d,
        { ...opts, key: `structured-analysis:${d.analysis.source.id}` },
        capability,
      );
    case "finance_breakdown":
      return visualsOr([financeBreakdownVisual(d.breakdown, opts.locale)], d, opts, capability);
    case "finance_budgets":
      // One budgets Surface: "subí herramientas a 180 mil" updates it instead of adding cards.
      return visualsOr(
        [budgetsVisual(d.budgets, opts.locale)],
        d,
        { ...opts, key: "finance-budgets" },
        capability,
      );
    case "habit_stats": {
      // One Surface per habit (or all) and range: a check-in refreshes it in place (ADR-053).
      const r = d.report;
      const who = r.habits.length === 1 ? r.habits[0]!.habitId : "all";
      return r.habits.length
        ? visualsOr(
            habitStatsVisuals(r, r.today, opts.locale),
            d,
            { ...opts, key: `habit:${who}:${r.range.view}:${r.range.from}` },
            capability,
          )
        : [];
    }
    case "habits":
      return isEmptyResult(d)
        ? []
        : visualsOr([habitsVisual(d.progress, opts.locale)], d, opts, capability);
    case "goals": {
      // One overview per scope (goals:<status>:<range>:<vision>): asking again or any goal or
      // habit change refreshes it in place (ADR-055).
      if (isEmptyResult(d)) return [];
      const titles = new Map((d.visions ?? []).map((v) => [v.vision.id, v.vision.title]));
      const sc = d.scope ?? { status: "active", from: null, to: null, visionId: null };
      const summary = d.summary ?? goalsSummary(d.goals);
      return one(
        draft(
          "goals_overview",
          `goals:${sc.status}:${sc.from ?? "all"}:${sc.to ?? "all"}:${sc.visionId ?? "all"}`,
          {
            goals: d.goals.slice(0, 30).map((g) => goalCard(g, titles)),
            total: d.goals.length,
            summary: {
              active: summary.active,
              atRisk: summary.atRisk,
              completed: summary.completed,
              averageProgress: summary.averageProgress,
            },
            visions: (d.visions ?? [])
              .filter((v) => v.vision.status !== "archived")
              .slice(0, 8)
              .map((v) => ({
                id: v.vision.id,
                title: clip(v.vision.title, 500),
                icon: v.vision.icon,
                active: v.active,
                completed: v.completed,
              })),
            scope: sc,
            today: todayIn(opts.timezone ?? "UTC"),
          },
          opts,
          {
            title: opts.locale === "en" ? "Goals" : "Objetivos",
            source: { capability: "goals", label: null },
            ref: null,
          },
        ),
      );
    }
    case "goal": {
      const x = d.detail;
      const g = x.snapshot.goal;
      return one(
        draft(
          "goal",
          g.id,
          {
            goal: goalCard(x.snapshot, new Map(x.visions.map((v) => [v.id, v.title]))),
            history: x.history.slice(-60),
            events: x.events.slice(0, 10).map((e) => ({
              at: e.occurredAt,
              value: e.newValue,
              previous: e.previousValue,
              note: e.note ? clip(e.note, 500) : null,
              source: e.sourceType,
            })),
            parent: x.parent ? { ...x.parent, title: clip(x.parent.title, 500) } : null,
            children: x.children.slice(0, 12).map((c) => ({
              id: c.id,
              title: clip(c.title, 500),
              icon: c.icon,
              percent: c.percent,
            })),
            related: x.related.slice(0, 12).map((r) => ({ ...r, title: clip(r.title, 500) })),
            today: x.today,
          },
          opts,
          {
            title: g.title,
            source: { capability: "goals", label: null },
            ref: { resource: "goal", id: g.id },
          },
        ),
      );
    }
    case "vision": {
      const x = d.detail;
      const v = x.vision;
      const titles = new Map([[v.id, v.title]]);
      return one(
        draft(
          "vision",
          v.id,
          {
            vision: {
              id: v.id,
              title: clip(v.title, 500),
              description: v.description ? clip(v.description, 1200) : null,
              icon: v.icon,
              area: v.area,
              status: v.status,
            },
            goals: x.goals.slice(0, 20).map((g) => goalCard(g, titles)),
            habits: x.habits.slice(0, 8).map((h) => ({
              name: clip(h.name, 120),
              icon: h.icon ?? null,
              done: h.done,
              goal: h.goal,
              drives: Boolean(h.drives),
            })),
            completed: x.goals.filter((g) => g.goal.status === "completed").length,
            total: x.goals.length,
            today: x.today,
          },
          opts,
          {
            title: v.title,
            source: { capability: "goals", label: null },
            ref: { resource: "vision", id: v.id },
          },
        ),
      );
    }
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

/**
 * One Surface per timer (keyed by its id): every change updates it in place. A cancelled
 * timer's Surface says so briefly and leaves (ADR-045).
 */
function timerSurface(t: SurfacePayloads["timer"], opts: PresentOptions): SurfaceDraft | null {
  const es = opts.locale === "es";
  const kind = { timer: "Timer", pomodoro: "Pomodoro", stopwatch: es ? "Cronómetro" : "Stopwatch" }[
    t.kind
  ];
  return draft("timer", t.id, t, opts, {
    title: t.label ?? kind,
    source: { capability: "time", label: null },
    ref: null,
    ...(t.state === "cancelled" ? { transient: true } : {}),
  });
}

/** Ops that present these Surfaces, in order. */
export function presentOps(drafts: SurfaceDraft[], at: string): WorkspaceOp[] {
  return drafts.map((surface) => ({ op: "present", surface, at }));
}

/**
 * A list shown now supersedes single-item cards of things it already contains (the task
 * created a moment ago, now in "Open items"), so the same item isn't on screen twice.
 */
export function supersededOps(
  state: WorkspaceState,
  drafts: SurfaceDraft[],
  at: string,
): WorkspaceOp[] {
  const listed = new Set(
    drafts
      .filter((d) => d.type === "task_list")
      .flatMap((d) => (d.payload as SurfacePayloads["task_list"]).items.map((i) => i.id)),
  );
  if (!listed.size) return [];
  return state.surfaces
    .filter((s) => s.type === "task" && s.ref && listed.has(s.ref.id))
    .map((s) => ({ op: "dismiss" as const, id: s.id, at }));
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
export { approvalDecidedOps } from "./approval-ops";

const INTENT_BY_CAPABILITY: Record<string, IntentKind> = {
  meeting: "meeting_prep",
  history: "recall",
  knowledge: "research",
  email: "communication",
  teamMessaging: "communication",
  calendar: "planning",
  tasks: "planning",
  habits: "planning",
  goals: "planning",
  lists: "planning",
  notes: "planning",
  web: "research",
  location: "planning",
  weather: "planning",
  music: "general",
  time: "general",
  study: "study",
  work: "work_brief",
  planning: "planning",
  briefs: "planning",
  shortcuts: "settings",
  contexts: "context_setup",
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
  // Switching or looking at a context isn't setting one up.
  if (/^contexts\.(activate|clear|get|list|findPeople)$/.test(toolName)) return "general";
  return INTENT_BY_CAPABILITY[prefix] ?? "general";
}
