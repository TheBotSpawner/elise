import type { MorningBrief } from "./morning-brief";
import type { ToolDisplay } from "../agents/tools";
import { briefExperience, spokenScript } from "../schedules/experience";
import type { SurfaceDraft } from "../workspace/model";
import { draftDefaults, PAYLOADS } from "../workspace/registry";

/**
 * A scheduled briefing as a normal Live Canvas session (ADR-041). The brief is gathered through
 * the executor; each read keeps its typed result and its query. Here ELISE decides which of
 * them deserve a Surface and how prominent each is. The canonical Canvas then presents,
 * composes, refreshes and reconciles them exactly like Surfaces of any conversation.
 */

/** One read the brief made (tool + arguments) and the typed result it returned. */
export interface BriefRead {
  block: string;
  tool: string;
  args: Record<string, unknown>;
  display: ToolDisplay;
}

/** A Surface to present: the read (re-run to refresh it) and its curated result. */
export interface BriefPresentItem {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  display: ToolDisplay;
  /** 0–100 (registry scale): ≥ 85 leads the Canvas, < 40 stays ambient. */
  priority: number;
}

const ids = <T extends { id: string }>(xs: readonly T[] | undefined) =>
  new Set((xs ?? []).map((x) => x.id));

/**
 * Relevance (ADR-041 §D): only what has something to say today, curated to what matters.
 * Nothing is invented; every item comes from a read the brief really made.
 */
export function briefCanvas(brief: MorningBrief, reads: readonly BriefRead[]): BriefPresentItem[] {
  const items: BriefPresentItem[] = [];
  const add = (r: BriefRead, display: ToolDisplay, priority: number) =>
    items.push({
      callId: `brief:${r.block}:${items.length}`,
      tool: r.tool,
      args: r.args,
      display,
      priority,
    });
  const attentionEmails = ids(brief.attention.emails);
  const keyTasks = new Set([...ids(brief.attention.tasks), ...ids(brief.waitingOnYou.overdue)]);
  const meetings = brief.today?.events.filter((e) => !e.allDay) ?? [];
  const withOthers = meetings.filter((e) => e.withOthers > 0).length;

  for (const r of reads) {
    const d = r.display;
    switch (d.kind) {
      case "event_list":
        // "No meetings" is information: the calendar stays, quiet when the day is empty.
        add(r, d, brief.today?.conflicts.length ? 88 : withOthers ? 80 : meetings.length ? 70 : 38);
        break;
      case "email_list": {
        const messages = d.messages.filter((m) => attentionEmails.has(m.id));
        // One urgent email leads; several important ones support.
        if (messages.length)
          add(
            r,
            { ...d, messages },
            messages.length === 1 && brief.attention.emails[0]?.important ? 84 : 72,
          );
        break;
      }
      case "email_followups":
        if (d.items.length) add(r, d, d.followUp === "needs_reply" ? 70 : 48);
        break;
      case "task_list": {
        const tasks = d.tasks.filter((t) => keyTasks.has(t.id));
        if (tasks.length) add(r, { ...d, tasks }, brief.waitingOnYou.overdue.length >= 3 ? 78 : 66);
        break;
      }
      case "habits":
        if (brief.habits?.length) add(r, d, 45);
        break;
      case "goals":
        if (brief.goals?.length) add(r, d, 42);
        break;
      case "weather":
        if (brief.weather) add(r, d, 52);
        break;
      case "finance_summary":
        // The month to date is the finance Surface; the comparison reads only ground the words.
        if (r.args.period === "this_month" && brief.finance?.month.length) add(r, d, 40);
        break;
      case "web_news":
        if (d.events.length) add(r, d, 35);
        break;
      default:
        break;
    }
  }
  return items;
}

/**
 * "Today's focus" (§M): the lead synthesis when there is one — the contexts with something
 * concrete today — never the whole brief as prose. Null when there is nothing to focus on.
 */
export function focusSurface(
  brief: MorningBrief,
  locale: "es" | "en",
  intentId: string | null,
): SurfaceDraft | null {
  const focus = brief.focus ?? [];
  if (!focus.length) return null;
  const es = locale === "es";
  const line = (f: (typeof focus)[number]) =>
    [
      f.name,
      f.meetings.length
        ? es
          ? `${f.meetings.length} reunión${f.meetings.length > 1 ? "es" : ""}`
          : `${f.meetings.length} meeting${f.meetings.length > 1 ? "s" : ""}`
        : null,
      f.tasks ? (es ? `${f.tasks} tareas` : `${f.tasks} tasks`) : null,
      f.replies ? (es ? `${f.replies} respuestas pendientes` : `${f.replies} replies`) : null,
      f.examDate ? (es ? `examen ${f.examDate}` : `exam ${f.examDate}`) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const parsed = PAYLOADS.summary.safeParse({
    sections: [
      {
        kind: "open_items",
        heading: es ? "Foco de hoy" : "Today's focus",
        items: focus.slice(0, 8).map(line),
      },
    ],
  });
  if (!parsed.success) return null;
  return {
    id: `summary:brief:${brief.date}`,
    type: "summary",
    title: es ? "Foco de hoy" : "Today's focus",
    state: "ready",
    source: { capability: "workspace", label: "ELISE" },
    ref: null,
    payload: parsed.data,
    intentId,
    ...draftDefaults("summary", parsed.data),
    priority: 86,
  };
}

/** Voice carries the synthesis: the greeting and what matters most, then the screen. */
export const SPOKEN_BRIEF_LIMIT = 400;

/**
 * What ELISE says when the brief opens (§H): the narration's greeting and the most important
 * lines, in the order the Canvas ranks them, short enough to be spoken in one breath. The
 * screen carries the detail; nothing is read item by item.
 */
export function spokenBrief(brief: MorningBrief, locale: "es" | "en"): string {
  const lines = spokenScript(briefExperience(brief, locale)).map((l) => l.text.trim());
  const closing = locale === "es" ? "Te dejé todo en pantalla." : "Everything is on screen.";
  let out = "";
  for (const line of lines) {
    if (!line) continue;
    const next = out ? `${out} ${line}` : line;
    if (next.length + closing.length + 1 > SPOKEN_BRIEF_LIMIT) break;
    out = next;
  }
  if (/pantalla|screen/i.test(out)) return out;
  return out ? `${out} ${closing}` : closing;
}
