import {
  briefIssues,
  briefTopics,
  type BriefEmail,
  type BriefEvent,
  type BriefFocus,
  type BriefFollowUp,
  type BriefGoal,
  type BriefHabit,
  type BriefKnowledge,
  type BriefNews,
  type BriefTask,
  type BriefTopic,
  type BriefWarning,
  type MorningBrief,
} from "../briefs/morning-brief";
import { toLocalDateTime } from "../time";
import type { VisualizationSpec } from "../workspace/visualization";
import type { WeatherPayload } from "../workspace/weather";

/**
 * Scheduled Experiences (ADR-039): what any scheduled run shows and says. A run is a short
 * assistant session — segments, each one spoken line plus the cards that line is about — not a
 * document. Morning Brief, weekly planning, reviews and future digests all render through this
 * one model; a run with only text is a single text segment.
 *
 * Blocks are typed data, rendered by ELISE's own components (the same Weather, chart and list
 * components as the Live Canvas). They never carry markup.
 */

export type ExperienceBlock =
  | { kind: "text"; markdown: string }
  | { kind: "chart"; spec: VisualizationSpec }
  | { kind: "weather"; weather: WeatherPayload }
  | {
      kind: "agenda";
      /** Which days: today (Morning Brief), tomorrow, or the next seven days. */
      span: "today" | "tomorrow" | "week";
      events: BriefEvent[];
      conflicts: { a: string; b: string }[];
      gaps: { start: string; end: string }[];
    }
  | { kind: "tasks"; due: BriefTask[]; overdue: BriefTask[] }
  | { kind: "emails"; emails: BriefEmail[] }
  | { kind: "followups"; waitingOnYou: BriefFollowUp[]; waitingOnOthers: BriefFollowUp[] }
  | { kind: "habits"; habits: BriefHabit[] }
  | { kind: "goals"; goals: BriefGoal[] }
  | { kind: "finance"; finance: NonNullable<MorningBrief["finance"]> }
  | { kind: "news"; news: BriefNews[] }
  | { kind: "knowledge"; knowledge: BriefKnowledge }
  | { kind: "focus"; focus: BriefFocus[] }
  | { kind: "issues"; warnings: BriefWarning[] };

export type ExperienceBlockKind = ExperienceBlock["kind"];

export interface ExperienceSegment {
  /** Stable within the run ("agenda", "tasks"…): playback and the UI follow it. */
  id: string;
  /** Short heading for the cards ("Hoy", "Tareas"); null for the opening. */
  label: string | null;
  /** What ELISE says over this segment: the spoken script and the visible message are one. */
  say: string | null;
  blocks: ExperienceBlock[];
}

export interface ScheduledExperience {
  version: 1;
  /** Local date the run is about, and the timezone its times are shown in. */
  date: string;
  timezone: string;
  segments: ExperienceSegment[];
  /** A longer written summary from older runs, kept as a secondary transcript. */
  transcript: string | null;
}

/** The spoken script: the segments' lines in order (empty lines skipped). */
export function spokenScript(x: ScheduledExperience): { segment: string; text: string }[] {
  return x.segments.flatMap((s) => (s.say ? [{ segment: s.id, text: s.say }] : []));
}

/** A run that only has text (a future job, or a fallback): one segment, still the same model. */
export function textExperience(
  markdown: string,
  date: string,
  timezone: string,
): ScheduledExperience {
  return {
    version: 1,
    date,
    timezone,
    segments: [{ id: "text", label: null, say: null, blocks: [{ kind: "text", markdown }] }],
    transcript: null,
  };
}

// ── Morning Brief (and every preset built on it) → experience ────────────────

type Locale = "es" | "en";

const LABELS: Record<Locale, Record<BriefTopic | "attention", string>> = {
  es: {
    focus: "Foco del día",
    agenda: "Agenda",
    tasks: "Tareas",
    weather: "Clima",
    inbox: "Correo",
    habits: "Hábitos",
    goals: "Objetivos",
    finance: "Finanzas",
    news: "Noticias",
    knowledge: "Conocimiento",
    attention: "Fuentes",
  },
  en: {
    focus: "Today's focus",
    agenda: "Agenda",
    tasks: "Tasks",
    weather: "Weather",
    inbox: "Email",
    habits: "Habits",
    goals: "Goals",
    finance: "Finance",
    news: "News",
    knowledge: "Knowledge",
    attention: "Sources",
  },
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What ELISE says when the model's narration isn't there (older runs, synthesis unavailable):
 * plain, true sentences computed from the same data the cards show.
 */
function fallbackLine(topic: BriefTopic, b: MorningBrief, locale: Locale): string | null {
  const es = locale === "es";
  const hhmm = (iso: string) => toLocalDateTime(new Date(iso), b.timezone).slice(11, 16);
  switch (topic) {
    case "focus":
      return es
        ? `Hoy el foco está en ${b.focus!.map((f) => f.name).join(" y ")}.`
        : `Today's focus is ${b.focus!.map((f) => f.name).join(" and ")}.`;
    case "agenda": {
      const events = b.today!.events;
      const multi = (b.period?.days ?? 1) > 1;
      const when = b.period
        ? multi
          ? es
            ? "esta semana"
            : "this week"
          : es
            ? "mañana"
            : "tomorrow"
        : es
          ? "hoy"
          : "today";
      if (!events.length)
        return es ? `No tenés reuniones ${when}.` : `You have no meetings ${when}.`;
      const first = events.find((e) => !e.allDay);
      const count = es
        ? `Tenés ${plural(events.length, "evento", "eventos")} ${when}`
        : `You have ${plural(events.length, "event", "events")} ${when}`;
      const lead =
        first && !multi
          ? es
            ? `; el primero es ${first.title}, a las ${hhmm(first.start)}`
            : `; the first is ${first.title}, at ${hhmm(first.start)}`
          : "";
      const clash = b.today!.conflicts.length
        ? es
          ? " Hay superposiciones."
          : " Some overlap."
        : "";
      return `${count}${lead}.${clash}`;
    }
    case "tasks": {
      const due = b.attention.tasks.length;
      const overdue = b.waitingOnYou.overdue.length;
      const parts = es
        ? [
            due ? plural(due, "tarea para hoy", "tareas para hoy") : "",
            overdue ? plural(overdue, "vencida", "vencidas") : "",
          ]
        : [due ? plural(due, "task due", "tasks due") : "", overdue ? `${overdue} overdue` : ""];
      return `${es ? "Tenés" : "You have"} ${parts.filter(Boolean).join(es ? " y " : " and ")}.`;
    }
    case "weather": {
      const d = b.weather!.days[0];
      if (!d) return null;
      const rain = d.precipitationProbability ?? 0;
      return es
        ? `Entre ${Math.round(d.min)} y ${Math.round(d.max)} grados${rain >= 40 ? `, con ${rain}% de probabilidad de lluvia` : ""}.`
        : `Between ${Math.round(d.min)} and ${Math.round(d.max)} degrees${rain >= 40 ? `, with a ${rain}% chance of rain` : ""}.`;
    }
    case "inbox": {
      const replies = b.waitingOnYou.replies.length;
      const mails = b.attention.emails.length;
      return es
        ? [
            mails ? `${plural(mails, "mail importante", "mails importantes")}` : "",
            replies
              ? `${plural(replies, "conversación espera", "conversaciones esperan")} tu respuesta`
              : "",
          ]
            .filter(Boolean)
            .join(" y ")
            .replace(/^./, (c) => c.toUpperCase())
            .concat(".")
        : [
            mails ? plural(mails, "important email", "important emails") : "",
            replies ? `${plural(replies, "thread is", "threads are")} waiting on your reply` : "",
          ]
            .filter(Boolean)
            .join(" and ")
            .replace(/^./, (c) => c.toUpperCase())
            .concat(".");
    }
    case "habits": {
      const risk = b.habits!.filter((h) => h.atRisk).length;
      return risk
        ? es
          ? `${plural(risk, "hábito está", "hábitos están")} en riesgo esta semana.`
          : `${plural(risk, "habit is", "habits are")} at risk this week.`
        : es
          ? "Tus hábitos de hoy te esperan."
          : "Your habits for today are waiting.";
    }
    case "goals":
      return es ? "Así vienen tus objetivos." : "Here's where your goals stand.";
    case "finance":
      return es ? "Un vistazo a tus finanzas del mes." : "A quick look at this month's finances.";
    case "news":
      return es
        ? `${plural(b.news!.length, "novedad", "novedades")} de tus temas.`
        : `${plural(b.news!.length, "update", "updates")} on your topics.`;
    case "knowledge":
      return b.knowledge!.changes.length
        ? es
          ? `Hubo ${plural(b.knowledge!.total, "cambio", "cambios")} en ${b.knowledge!.scope}.`
          : `${plural(b.knowledge!.total, "change", "changes")} in ${b.knowledge!.scope}.`
        : null;
  }
}

function blocksFor(topic: BriefTopic, b: MorningBrief): ExperienceBlock[] {
  switch (topic) {
    case "focus":
      return [{ kind: "focus", focus: b.focus! }];
    case "agenda":
      return [
        {
          kind: "agenda",
          span: !b.period ? "today" : b.period.days > 1 ? "week" : "tomorrow",
          events: b.today!.events,
          conflicts: b.today!.conflicts,
          gaps: b.today!.gaps,
        },
      ];
    case "tasks":
      return [{ kind: "tasks", due: b.attention.tasks, overdue: b.waitingOnYou.overdue }];
    case "weather":
      return [{ kind: "weather", weather: b.weather! }];
    case "inbox":
      return [
        ...(b.attention.emails.length
          ? [{ kind: "emails" as const, emails: b.attention.emails }]
          : []),
        ...(b.waitingOnYou.replies.length || b.waitingOnOthers.length
          ? [
              {
                kind: "followups" as const,
                waitingOnYou: b.waitingOnYou.replies,
                waitingOnOthers: b.waitingOnOthers,
              },
            ]
          : []),
      ];
    // A chart when the data allows one (the habits week, goal progress); the list otherwise.
    case "habits":
      return b.charts?.habits
        ? [{ kind: "chart", spec: b.charts.habits }]
        : [{ kind: "habits", habits: b.habits! }];
    case "goals":
      return b.charts?.goals
        ? [{ kind: "chart", spec: b.charts.goals }]
        : [{ kind: "goals", goals: b.goals! }];
    case "finance":
      return [
        ...(b.charts?.finance ?? []).map((spec) => ({ kind: "chart" as const, spec })),
        { kind: "finance", finance: b.finance! },
      ];
    case "news":
      return [{ kind: "news", news: b.news! }];
    case "knowledge":
      return [{ kind: "knowledge", knowledge: b.knowledge! }];
  }
}

/**
 * The relevance layer: only the parts with something to show, in the order ELISE presents them.
 * The agenda always appears when the calendar was asked for — "no meetings" is information.
 * Problems with sources come last, compact and silent unless the narration mentions them.
 */
export function briefExperience(brief: MorningBrief, locale: Locale): ScheduledExperience {
  const n = brief.narration ?? null;
  const labels = LABELS[locale];
  const greeting =
    n?.greeting ??
    (locale === "es" ? "Buen día. Esto es lo que tenés." : "Good morning. Here's your day.");
  const segments: ExperienceSegment[] = [{ id: "intro", label: null, say: greeting, blocks: [] }];
  for (const topic of briefTopics(brief)) {
    const blocks = blocksFor(topic, brief);
    if (!blocks.length) continue;
    segments.push({
      id: topic,
      label: labels[topic],
      say: n?.lines[topic] ?? fallbackLine(topic, brief, locale),
      blocks,
    });
  }
  if (n?.closing) segments.push({ id: "closing", label: null, say: n.closing, blocks: [] });
  const issues = briefIssues(brief.warnings);
  if (issues.length)
    segments.push({
      id: "attention",
      label: labels.attention,
      say: null,
      blocks: [{ kind: "issues", warnings: issues }],
    });
  // Nothing at all to show: say so plainly instead of an empty page.
  if (segments.length === 1 && !issues.length)
    segments[0]!.say =
      n?.greeting ??
      (locale === "es" ? "Nada te necesita esta mañana." : "Nothing needs you this morning.");
  return {
    version: 1,
    date: brief.date,
    timezone: brief.timezone,
    segments,
    transcript: brief.narrative ?? null,
  };
}
