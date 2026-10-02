import { clipText } from "../text";
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
import {
  financeBreakdownVisual,
  financeSummaryVisuals,
  goalPace,
  goalsVisual,
  habitsVisual,
  type BuiltVisualization,
  type VizLocale,
} from "./visualization";
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
  /** The user's language, for the few words derived charts carry (ADR-021). */
  locale?: VizLocale;
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
    case "finance_breakdown":
      return visualsOr([financeBreakdownVisual(d.breakdown, opts.locale)], d, opts, capability);
    case "habits":
      return isEmptyResult(d)
        ? []
        : visualsOr([habitsVisual(d.progress, opts.locale)], d, opts, capability);
    case "goals": {
      if (isEmptyResult(d)) return [];
      const today = new Date().toISOString().slice(0, 10);
      return visualsOr(
        [
          goalsVisual(
            d.goals.map((g) => ({
              title: g.goal.title,
              percent: g.progress.percent,
              pace:
                g.goal.status === "completed"
                  ? null
                  : goalPace(g.goal.createdAt, g.goal.targetDate, today),
            })),
            opts.locale,
          ),
        ],
        d,
        opts,
        capability,
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
  calendar: "planning",
  tasks: "planning",
  habits: "planning",
  goals: "planning",
  lists: "planning",
  notes: "planning",
  web: "research",
  location: "planning",
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
