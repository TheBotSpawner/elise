import { z } from "zod";

import type { ToolCallOutcome } from "../agents/executor";
import type { KnowledgeEvidence, ToolDefinition, ToolRunEnv } from "../agents/tools";
import type { CalendarEvent } from "../capabilities/calendar";
import type { EmailMessage } from "../capabilities/email";
import type { Task } from "../capabilities/tasks";
import type { RecallResult } from "../recall/model";
import { addDays, isIsoDate, toLocalDateTime, todayIn } from "../time";
import {
  emailListSurface,
  eventSurface,
  knowledgeSurface,
  presentOps,
  surfacesFromOutcome,
  taskListSurface,
} from "../workspace/from-results";
import { surfaceId, type SurfaceDraft } from "../workspace/model";
import { draftDefaults, PAYLOADS } from "../workspace/registry";

/**
 * Meeting preparation (ADR-013 §12, use case CAL-006): an orchestration on ELISE Core, not a
 * separate agent. It resolves the meeting deterministically, gathers context in parallel
 * through the normal executor (each read under its own permissions), presents Surfaces as each
 * source returns, and hands the model organized facts plus untrusted retrieved context. The
 * brief itself is written by the model, with facts, context and suggestions kept apart.
 */

const input = z
  .object({
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional()
      .describe('Local time the user mentions, "12:00" for "a las 12".'),
    date: z.string().refine(isIsoDate, "YYYY-MM-DD").optional().describe("Local date, if said."),
    with: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .optional()
      .describe("A participant the user names (name or email)."),
    about: z
      .string()
      .trim()
      .min(2)
      .max(200)
      .optional()
      .describe("Words from the meeting's title or topic."),
    event: z.string().trim().min(1).max(1000).optional().describe("An event id already shown."),
  })
  .strict();
type Input = z.infer<typeof input>;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STOP = new Set(
  "the and for with meeting reunion reunión call sync weekly daily review con para del los las una por que".split(
    " ",
  ),
);
const words = (s: string) =>
  norm(s)
    .split(/[^a-z0-9@.]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail)$/;

const isResource = (email: string) => /resource\.calendar\.google\.com$/.test(email);
const others = (e: CalendarEvent) => e.attendees.filter((a) => !a.self && !isResource(a.email));

export interface MeetingPick {
  event: CalendarEvent | null;
  /** Several equally good matches: ask which one. */
  ambiguous: CalendarEvent[];
}

/**
 * Chooses the meeting from the user's hints, deterministically. No hints: the one happening
 * now, else the next one. Hints that match nothing give no event (never a guess).
 */
export function pickMeeting(
  events: CalendarEvent[],
  hints: Input,
  now: Date,
  timezone: string,
): MeetingPick {
  const candidates = events.filter(
    (e) =>
      !e.allDay &&
      e.status !== "cancelled" &&
      !e.attendees.some((a) => a.self && a.response === "declined") &&
      Date.parse(e.end) > now.getTime() - 15 * 60_000,
  );
  if (hints.event) {
    const exact = candidates.find((e) => e.id === hints.event);
    return { event: exact ?? null, ambiguous: [] };
  }
  const withWords = hints.with ? words(hints.with) : [];
  const aboutWords = hints.about ? words(hints.about) : [];
  const scored = candidates.map((e) => {
    let hint = 0;
    if (withWords.length) {
      const people =
        others(e)
          .map((a) => norm(`${a.name ?? ""} ${a.email}`))
          .join(" ") +
        " " +
        norm(e.title);
      if (withWords.some((w) => people.includes(w))) hint += 50;
    }
    if (aboutWords.length) {
      const title = norm(`${e.title} ${e.description ?? ""}`);
      hint += (40 * aboutWords.filter((w) => title.includes(w)).length) / aboutWords.length;
    }
    if (hints.time) {
      const local = toLocalDateTime(new Date(e.start), timezone);
      const [h, m] = hints.time.split(":").map(Number) as [number, number];
      const [eh, em] = local.slice(11, 16).split(":").map(Number) as [number, number];
      const diff = Math.abs(eh * 60 + em - (h * 60 + m));
      // "a las 12" may be 12:00 or noon-ish; half-day ambiguity (12 vs 00) is ignored.
      if (diff <= 90) hint += 30 - diff / 3;
    }
    const start = Date.parse(e.start);
    const ongoing = start <= now.getTime() && Date.parse(e.end) > now.getTime();
    // Sooner is better when hints tie; an ongoing meeting first.
    const soon = ongoing ? 6 : -Math.max(0, (start - now.getTime()) / 3_600_000) * 0.25;
    return { e, hint, score: hint + soon };
  });
  const hinted = Boolean(withWords.length || aboutWords.length || hints.time);
  const pool = hinted ? scored.filter((s) => s.hint > 0) : scored;
  if (!pool.length) return { event: null, ambiguous: [] };
  pool.sort((a, b) => b.score - a.score);
  const [first, second] = pool;
  // Two different meetings matching the hints equally well: ask, don't guess.
  if (
    hinted &&
    second &&
    Math.abs(first!.hint - second.hint) < 1 &&
    first!.hint > 0 &&
    first!.e.id !== second.e.id
  )
    return {
      event: null,
      ambiguous: pool
        .slice(0, 4)
        .filter((p) => Math.abs(p.hint - first!.hint) < 1)
        .map((p) => p.e),
    };
  return { event: first!.e, ambiguous: [] };
}

/** Words that tie other data to this meeting: title words, first names, company domains. */
export function meetingKeywords(e: CalendarEvent): string[] {
  const set = new Set(words(e.title));
  for (const a of others(e)) {
    const first = a.name ? norm(a.name).split(/\s+/)[0] : null;
    if (first && first.length >= 3) set.add(first);
    const domain = a.email.split("@")[1]?.split(".")[0];
    if (domain && domain.length >= 3 && !FREE_MAIL.test(domain)) set.add(norm(domain));
  }
  return [...set].slice(0, 12);
}

export function relatedTasks(tasks: Task[], keywords: string[]): Task[] {
  if (!keywords.length) return [];
  return tasks.filter((t) => {
    const text = norm(`${t.title} ${t.notes ?? ""} ${t.description ?? ""}`);
    return keywords.some((k) =>
      new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text),
    );
  });
}

const clip = (s: string | null | undefined, n: number) =>
  !s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s;

type Source = "calendar" | "email" | "recall" | "knowledge" | "tasks";
const STEP_TOOL: Record<Source, string> = {
  calendar: "calendar.listEvents",
  email: "email.search",
  recall: "history.search",
  knowledge: "knowledge.search",
  tasks: "tasks.list",
};

/** Runs one source as an activity step; a failure is reported, never thrown. */
async function step<T>(
  env: ToolRunEnv,
  source: Source,
  run: () => Promise<{ value: T; outcome: ToolCallOutcome | null }>,
): Promise<{ value: T | null; problem: string | null }> {
  const id = `${source}:${crypto.randomUUID().slice(0, 8)}`;
  env.ctx.workspace?.activity({ id, tool: STEP_TOOL[source], status: "running" });
  try {
    const { value, outcome } = await run();
    if (outcome && outcome.status !== "succeeded") {
      const unavailable =
        outcome.status === "failed" &&
        ["CAPABILITY_UNAVAILABLE", "AUTH_ERROR", "PERMISSION_DENIED"].includes(outcome.error.code);
      env.ctx.workspace?.activity({
        id,
        tool: STEP_TOOL[source],
        status: unavailable ? "unavailable" : "failed",
      });
      return {
        value: null,
        problem: `${source}: ${outcome.status === "failed" ? (unavailable ? "not connected or not allowed" : outcome.error.code) : outcome.status}`,
      };
    }
    env.ctx.workspace?.activity({ id, tool: STEP_TOOL[source], status: "done" });
    return { value, problem: null };
  } catch {
    env.ctx.workspace?.activity({ id, tool: STEP_TOOL[source], status: "failed" });
    return { value: null, problem: `${source}: failed` };
  }
}

function invoke(env: ToolRunEnv, name: string, args: unknown): Promise<ToolCallOutcome> {
  if (!env.invoke) throw new Error("Nested reads are unavailable");
  return env.invoke(name, args);
}

const displayOf = <K extends string>(o: ToolCallOutcome, kind: K) =>
  o.status === "succeeded" && o.display?.kind === kind
    ? (o.display as Extract<typeof o.display, { kind: K }>)
    : null;

export const prepareMeetingTool: ToolDefinition = {
  name: "meeting.prepare",
  capability: "workspace",
  operation: "prepareMeeting",
  description:
    '"Preparame para mi próxima reunión", "creo que tengo una reunión a las 12", "¿con quién me junto ahora?", "help me prepare for my meeting with Rod": finds the meeting and gathers its context (email with the participants, earlier conversations, documents, related open tasks, links) into the Live Workspace. Pass only what the user said. Then write the brief with ui.present.',
  input,
  async describe() {
    return { summary: "Prepare meeting" };
  },
  async run(raw, env) {
    const q = input.parse(raw);
    const tz = env.ctx.timezone;
    const now = env.ctx.now;
    const at = now.toISOString();
    const w = env.ctx.workspace;
    const unavailable: string[] = [];

    // 1. The meeting.
    const today = todayIn(tz, now);
    const from = q.date ?? toLocalDateTime(new Date(now.getTime() - 60 * 60_000), tz);
    const to = q.date ? addDays(q.date, 1) : addDays(today, 7);
    const cal = await step(env, "calendar", async () => {
      const outcome = await invoke(env, "calendar.listEvents", { from, to, limit: 100 });
      return { value: displayOf(outcome, "event_list")?.events ?? [], outcome };
    });
    if (cal.problem) {
      return {
        output: {
          found: false,
          unavailable: [cal.problem],
          instructions:
            "The calendar isn't available, so the meeting can't be found. Say so and offer to connect Google Calendar in Connections.",
        },
      };
    }
    const pick = pickMeeting(cal.value ?? [], q, now, tz);
    if (!pick.event) {
      const options = (pick.ambiguous.length ? pick.ambiguous : (cal.value ?? []).slice(0, 5)).map(
        (e) => ({
          event: e.id,
          title: e.title,
          start: toLocalDateTime(new Date(e.start), tz),
        }),
      );
      return {
        output: {
          found: false,
          ambiguous: pick.ambiguous.length > 0,
          options,
          instructions: pick.ambiguous.length
            ? "Several meetings match. Ask which one (by title and time), then call meeting.prepare with its event id."
            : "No meeting matches what the user said in the next days. Say so, and mention the upcoming ones if any.",
        },
      };
    }
    const event = pick.event;
    const intentId = `intent:${surfaceId("meeting", event.id)}`;
    const people = others(event);
    w?.apply([
      {
        op: "intent",
        intent: { id: intentId, kind: "meeting_prep", description: event.title, startedAt: at },
        at,
      },
      ...presentOps(
        [eventSurface(event, { key: event.id, intentId, priority: 100 }, "meeting")].filter(
          Boolean,
        ) as SurfaceDraft[],
        at,
      ),
    ]);
    const present = (d: SurfaceDraft | null) => {
      if (d) w?.apply(presentOps([d], new Date().toISOString()));
    };

    // 2. Context, in parallel; each source appears as soon as it returns.
    const keywords = meetingKeywords(event);
    const after = addDays(today, -60);
    const topic = clip(
      `${event.title} ${people.map((p) => p.name ?? p.email.split("@")[0]).join(" ")}`,
      300,
    );

    const [email, recall, knowledge, tasks] = await Promise.all([
      step(env, "email", async () => {
        const searches: Record<string, unknown>[] = people.length
          ? people.slice(0, 3).map((p) => ({ from: p.email, after, limit: 5 }))
          : [{ text: clip(event.title, 200), after, limit: 5 }];
        if (people[0]) searches.push({ to: people[0].email, after, limit: 3 });
        const outcomes = await Promise.all(searches.map((s) => invoke(env, "email.search", s)));
        const failed = outcomes.find((o) => o.status !== "succeeded") ?? null;
        const messages = outcomes.flatMap((o) => displayOf(o, "email_list")?.messages ?? []);
        if (!messages.length && failed) return { value: [] as EmailMessage[], outcome: failed };
        present(
          emailListSurface(messages, {
            key: `${intentId}:email`,
            intentId,
            priority: 70,
            title: event.title,
          }),
        );
        return { value: messages, outcome: null };
      }),
      step(env, "recall", async () => {
        const outcome = await invoke(env, "history.search", { query: topic, limit: 3 });
        const d = displayOf(outcome, "recall_results");
        if (d)
          for (const s of surfacesFromOutcome("history.search", outcome, {
            key: `${intentId}:recall`,
            intentId,
            priority: 75,
          }))
            present(s);
        return { value: d?.results ?? ([] as RecallResult[]), outcome };
      }),
      step(env, "knowledge", async () => {
        const outcome = await invoke(env, "knowledge.search", {
          query: clip(`${event.title} ${q.about ?? ""}`.trim(), 500),
          everywhere: true,
        });
        const d = displayOf(outcome, "knowledge_evidence");
        if (d)
          present(
            knowledgeSurface(d.evidence, d.enough, {
              key: `${intentId}:knowledge`,
              intentId,
              priority: 60,
              query: event.title,
            }),
          );
        return { value: d?.enough ? d.evidence : ([] as KnowledgeEvidence[]), outcome };
      }),
      step(env, "tasks", async () => {
        const outcome = await invoke(env, "tasks.list", { status: "open", limit: 200 });
        const related = relatedTasks(displayOf(outcome, "task_list")?.tasks ?? [], keywords).slice(
          0,
          8,
        );
        present(taskListSurface(related, { key: `${intentId}:tasks`, intentId, priority: 65 }));
        return { value: related, outcome };
      }),
    ]);
    for (const r of [email, recall, knowledge, tasks]) if (r.problem) unavailable.push(r.problem);

    // 3. The person, for a one-to-one with email history (no entity system yet: attendee data only).
    const messages = email.value ?? [];
    if (people.length === 1 && messages.length) {
      const p = people[0]!;
      const theirs = messages.filter(
        (m) =>
          norm(m.from?.email ?? "") === norm(p.email) ||
          m.to.some((t) => norm(t.email) === norm(p.email)),
      );
      const payload = PAYLOADS.person.parse({
        name: p.name,
        email: p.email,
        role: p.organizer ? "organizer" : "attendee",
        lastEmailAt: theirs[0]?.date ?? null,
        threads: new Set(theirs.map((m) => m.threadId)).size,
      });
      present({
        id: surfaceId("person", p.email),
        type: "person",
        title: p.name ?? p.email,
        state: "ready",
        source: { capability: "calendar", label: event.provenance.source },
        ref: null,
        payload,
        intentId,
        ...draftDefaults("person", payload),
      });
    }

    // 4. Useful links: from the event and the documents found (never invented).
    const docLinks = (knowledge.value ?? [])
      .filter((e) => e.url)
      .map((e) => ({ title: clip(e.title, 200), url: e.url!, kind: "document" as const }));
    const eventLinks = [
      ...new Set((event.description ?? "").match(/https:\/\/[^\s<>"')\]]+/g) ?? []),
    ]
      .filter((u) => u !== event.meetingUrl)
      .slice(0, 4)
      .map((u) => ({
        title: clip(u.replace(/^https:\/\//, ""), 200),
        url: u,
        kind: "web" as const,
      }));
    const links = [...new Map([...eventLinks, ...docLinks].map((l) => [l.url, l])).values()].slice(
      0,
      6,
    );
    const linksPayload = PAYLOADS.links.safeParse({ links });
    if (links.length && linksPayload.success) {
      present({
        id: surfaceId("links", intentId),
        type: "links",
        title: event.title,
        state: "ready",
        source: { capability: "workspace", label: null },
        ref: null,
        payload: linksPayload.data,
        intentId,
        ...draftDefaults("links", linksPayload.data),
      });
    }

    // 5. Organized context for the brief. Retrieved text is data, never instructions.
    const local = (iso: string) => toLocalDateTime(new Date(iso), tz);
    return {
      output: {
        found: true,
        meeting: {
          event: event.id,
          title: event.title,
          start: local(event.start),
          end: local(event.end),
          minutesUntilStart: Math.round((Date.parse(event.start) - now.getTime()) / 60_000),
          calendar: event.calendarName,
          account: event.provenance.source,
          location: event.location,
          hasVideoLink: Boolean(event.meetingUrl),
          organizer: event.attendees.find((a) => a.organizer)?.email ?? null,
          participants: people.map((p) => ({ name: p.name, email: p.email, response: p.response })),
          untrustedDescription: clip(event.description, 600) || null,
        },
        communication: [...new Map(messages.map((m) => [m.threadId, m])).values()]
          .slice(0, 5)
          .map((m) => ({
            thread: m.threadId,
            subject: m.subject,
            from: m.from?.name ?? m.from?.email ?? null,
            date: m.date.slice(0, 10),
            untrustedSnippet: clip(m.snippet, 240),
          })),
        recentContext: (recall.value ?? []).map((r) => ({
          interaction: r.interactionId,
          date: r.date.slice(0, 10),
          title: r.title,
          ...(r.summary ? { summary: r.summary } : {}),
          untrustedExcerpts: r.excerpts.map((e) => e.text),
        })),
        documents: [...new Map((knowledge.value ?? []).map((e) => [e.itemId, e])).values()]
          .slice(0, 4)
          .map((e) => ({
            item: e.itemId,
            document: e.title,
            space: e.spaceName,
            untrustedPassage: clip(e.snippet, 280),
          })),
        openItems: (tasks.value ?? []).map((t) => ({
          task: t.id,
          title: t.title,
          due: t.dueDate,
          source: t.provenance.source,
        })),
        unavailable,
        instructions:
          "The workspace already shows the meeting and every source found. Now call ui.present {type:'summary'} with the brief: facts (only what the calendar says), context (from earlier conversations, email and documents — attribute each), changes (what changed recently, if the evidence shows it), open_items, questions worth discussing, suggestions (clearly yours), material. Never invent the meeting's purpose: if the evidence doesn't show it, say so. Omit empty sections. Then reply in one or two sentences — don't repeat the Surfaces — and name any unavailable source.",
      },
    };
  },
};

export const MEETING_TOOLS = [prepareMeetingTool];
