import type { ToolCallOutcome } from "./executor";

/**
 * Quick reads (ADR-123): plain questions about the user's own ELISE data ("¿tengo alarmas
 * hoy?", "¿cómo van mis timers?") are answered without the model. The read is decided here,
 * runs through the same executor (validation, policy, audit) and the spoken answer is written
 * from its result. Anything else — a change, a filter, a follow-up — goes to the model as usual.
 */

export interface QuickRead {
  calls: { name: string; args: Record<string, unknown> }[];
  /** The spoken answer from the reads' results; null hands the turn to the model. */
  answer: (outcomes: ToolCallOutcome[], locale: "es" | "en", today: string) => string | null;
}

/** The whole message, plain: lowercase, no accents or punctuation, no "Elis," in front. */
const plain = (m: string) =>
  m
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(elis|elise|eli)\s+/, "");

/**
 * "¿Qué tareas tengo hoy?", "mis tareas pendientes", "¿tengo tareas para hoy?" — the whole
 * question, nothing more: a specific task ("la tarea de Félix") is a search, the model's.
 */
const TASKS_QUESTION = [
  /^(que |cuales )?(son )?(mis )?tareas( tengo| hay| me quedan| quedan)?( pendientes)?( (para|de) hoy| hoy)?$/,
  /^(tengo|hay)( alguna)? tareas?( pendientes)?( (para|de) hoy| hoy)?$/,
];

const ALARM = /(?<!\p{L})(alarmas?|alarms?)(?!\p{L})/iu;
const TIMER =
  /(?<!\p{L})(timers?|temporizador(es)?|cron[oó]metros?|pomodoros?|stopwatch)(?!\p{L})/iu;
/**
 * Anything that asks for a change (or a detail the list doesn't answer) is the model's.
 * Imperatives with their accent ("activá", "pará"), so "activas" or "para mañana" still read.
 */
const NOT_A_READ =
  /(?<!\p{L})((pon[eé]|cre[aá]|program[aá]|configur[aá]|borr[aá]|elimin[aá]|cambi[aá]|mov[eé]|apag[aá]|desactiv[aá]|agreg[aá]|sac[aá]|quit[aá]|posterg[aá]|silenci[aá]|paus[aá]|reinici[aá]|cancel[aá]|arranc[aá]|empez[aá]|inici[aá])(me|la|lo|las|los|le)?|activá\p{L}*|pará\p{L}*|seguí|pospon\p{L}*|despertame|sonidos?|tonos?|dispositivos?|d[oó]nde|set|delete|remove|change|turn|snooze|start|stop|pause|sound|where|y si|despu[eé]s)(?!\p{L})/iu;
const TODAY = /(?<!\p{L})(hoy|today)(?!\p{L})/iu;
const TOMORROW = /(?<!\p{L})(ma[ñn]ana|tomorrow)(?!\p{L})/iu;

/** A short question, not a request with conditions ("…y si no, …"). */
const short = (m: string) => m.trim().split(/\s+/).length <= 10;

export function quickRead(message: string): QuickRead | null {
  const q = plain(message);
  if (TASKS_QUESTION.some((re) => re.test(q))) {
    // One read of what's open (the same list the Tasks screen shows); today's and the overdue
    // ones are told apart by date, as the model would mention both.
    const forToday = / hoy$/.test(q);
    return {
      calls: [{ name: "tasks.list", args: { limit: 100 } }],
      answer: ([o], locale, today) => (o ? tasksAnswer(o, locale, forToday ? today : null) : null),
    };
  }
  if (!short(message) || NOT_A_READ.test(message)) return null;
  if (ALARM.test(message) && !TIMER.test(message)) {
    // "a la mañana" is a time of day, not tomorrow: only a bare "mañana" asks for tomorrow.
    const day = TODAY.test(message)
      ? "today"
      : TOMORROW.test(message) && !/a la ma[ñn]ana/iu.test(message)
        ? "tomorrow"
        : undefined;
    return {
      calls: [{ name: "time.listAlarms", args: day ? { day } : {} }],
      answer: ([o], locale) => (o ? alarmsAnswer(o, locale) : null),
    };
  }
  if (TIMER.test(message) && !ALARM.test(message))
    return {
      calls: [{ name: "time.list", args: {} }],
      answer: ([o], locale) => (o ? timersAnswer(o, locale) : null),
    };
  return null;
}

/** At most this many titles are said aloud; the rest are on screen. */
const SAID = 6;

interface TaskLine {
  title: string;
  dueDate: string | null;
}

function tasksAnswer(
  outcome: ToolCallOutcome,
  locale: "es" | "en",
  today: string | null,
): string | null {
  if (outcome.status !== "succeeded") return null;
  const open = (outcome.output as { tasks?: TaskLine[] }).tasks;
  if (!Array.isArray(open)) return null;
  const es = locale === "es";
  const titles = (ts: TaskLine[]) => {
    const said = ts.slice(0, SAID).map((t) => t.title);
    const more = ts.length - said.length;
    return list(more ? [...said, es ? `${more} más` : `${more} more`] : said, locale);
  };
  const count = (n: number) =>
    es ? (n === 1 ? "una tarea" : `${n} tareas`) : n === 1 ? "one task" : `${n} tasks`;
  if (!today) {
    if (!open.length) return es ? "No tenés tareas pendientes." : "You have no open tasks.";
    return es
      ? `Tenés ${count(open.length)} ${open.length === 1 ? "pendiente" : "pendientes"}: ${titles(open)}.`
      : `You have ${count(open.length)} open: ${titles(open)}.`;
  }
  const due = open.filter((t) => t.dueDate === today);
  const late = open.filter((t) => t.dueDate !== null && t.dueDate < today);
  const head = due.length
    ? es
      ? `Para hoy tenés ${count(due.length)}: ${titles(due)}.`
      : `Today you have ${count(due.length)}: ${titles(due)}.`
    : es
      ? "Para hoy no tenés tareas."
      : "No tasks for today.";
  const overdue = late.length
    ? es
      ? ` Además, ${late.length === 1 ? "una vencida" : `${late.length} vencidas`}: ${titles(late)}.`
      : ` Also ${late.length} overdue: ${titles(late)}.`
    : "";
  return head + overdue;
}

interface AlarmLine {
  label: string | null;
  time: string;
  enabled: boolean;
  nextRing: string | null;
  alreadyRang?: boolean;
}

const list = (items: string[], locale: "es" | "en") =>
  items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} ${locale === "es" ? "y" : "and"} ${items.at(-1)}`;

function alarmsAnswer(outcome: ToolCallOutcome, locale: "es" | "en"): string | null {
  if (outcome.status !== "succeeded") return null;
  const o = outcome.output as { day?: string; alarms?: AlarmLine[] };
  if (!Array.isArray(o.alarms)) return null;
  const es = locale === "es";
  const named = (a: AlarmLine) =>
    `${es ? "a las" : "at"} ${a.time}${a.label ? ` (${a.label})` : ""}${
      a.alreadyRang ? (es ? ", que ya sonó" : ", which already rang") : ""
    }`;
  if (o.day) {
    const when = o.alarms.length && o.alarms.every((a) => a.alreadyRang);
    if (!o.alarms.length)
      return es ? "No, no tenés alarmas para ese día." : "No, you have no alarms that day.";
    const n = o.alarms.length;
    const lead = es
      ? `Sí, ${n === 1 ? "una" : n}: ${list(o.alarms.map(named), locale)}.`
      : `Yes, ${n === 1 ? "one" : n}: ${list(o.alarms.map(named), locale)}.`;
    return when ? `${lead} ${es ? "No te queda ninguna más." : "None left."}` : lead;
  }
  const on = o.alarms.filter((a) => a.enabled && a.nextRing);
  const off = o.alarms.length - on.length;
  if (!o.alarms.length) return es ? "No tenés alarmas." : "You have no alarms.";
  const head = on.length
    ? es
      ? `Tenés ${on.length === 1 ? "una alarma activa" : `${on.length} alarmas activas`}: ${list(on.map(named), locale)}.`
      : `You have ${on.length === 1 ? "one alarm on" : `${on.length} alarms on`}: ${list(on.map(named), locale)}.`
    : es
      ? "No tenés ninguna alarma activa."
      : "None of your alarms is on.";
  const rest = off
    ? es
      ? ` ${off === 1 ? "Otra está apagada" : `Otras ${off} están apagadas`}.`
      : ` ${off === 1 ? "Another one is off" : `${off} more are off`}.`
    : "";
  return head + rest;
}

interface TimerLine {
  kind: string;
  label: string | null;
  state: string;
  remainingSpoken?: string;
  elapsed?: string;
}

function timersAnswer(outcome: ToolCallOutcome, locale: "es" | "en"): string | null {
  if (outcome.status !== "succeeded") return null;
  const o = outcome.output as { timers?: TimerLine[] };
  if (!Array.isArray(o.timers)) return null;
  const es = locale === "es";
  if (!o.timers.length)
    return es ? "No tenés ningún timer andando." : "You have no timers running.";
  const line = (t: TimerLine) => {
    const name = t.label ?? (es ? "el timer" : "the timer");
    if (t.kind === "stopwatch")
      return es ? `${name}: lleva ${t.elapsed}` : `${name}: ${t.elapsed} so far`;
    const paused = t.state === "paused" ? (es ? " (en pausa)" : " (paused)") : "";
    return es
      ? `a ${name} le quedan ${t.remainingSpoken}${paused}`
      : `${name} has ${t.remainingSpoken} left${paused}`;
  };
  const text = list(o.timers.map(line), locale);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
