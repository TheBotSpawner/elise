import type { ToolCallOutcome } from "./executor";

/**
 * Quick reads (ADR-123): plain questions about the user's own ELISE data ("¿tengo alarmas
 * hoy?", "¿cómo van mis timers?") are answered without the model. The read is decided here,
 * runs through the same executor (validation, policy, audit) and the spoken answer is written
 * from its result. Anything else — a change, a filter, a follow-up — goes to the model as usual.
 */

export interface QuickRead {
  call: { name: string; args: Record<string, unknown> };
  /** The spoken answer from the read's result; null hands the turn to the model. */
  answer: (outcome: ToolCallOutcome, locale: "es" | "en") => string | null;
}

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
  if (!short(message) || NOT_A_READ.test(message)) return null;
  if (ALARM.test(message) && !TIMER.test(message)) {
    // "a la mañana" is a time of day, not tomorrow: only a bare "mañana" asks for tomorrow.
    const day = TODAY.test(message)
      ? "today"
      : TOMORROW.test(message) && !/a la ma[ñn]ana/iu.test(message)
        ? "tomorrow"
        : undefined;
    return { call: { name: "time.listAlarms", args: day ? { day } : {} }, answer: alarmsAnswer };
  }
  if (TIMER.test(message) && !ALARM.test(message))
    return { call: { name: "time.list", args: {} }, answer: timersAnswer };
  return null;
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
