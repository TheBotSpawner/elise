import { addDays } from "../time";

/**
 * How ELISE looks for an email (ADR-099): the provider's search is literal — every word must be
 * there, and dates are when a message ARRIVED. "¿Hay un correo para la clase de hoy?" is about
 * a day, not a delivery date: the notice usually arrives days before, and its words aren't the
 * user's ("Actividades para el Lunes 19/10", not "clase de hoy"). So a search that finds
 * nothing is retried a few deterministic ways, each one said, never silently.
 */

export interface SearchShape {
  text?: string;
  from?: string;
  subject?: string;
  /** Received on or after (local YYYY-MM-DD). */
  after?: string;
  /** Received before (local YYYY-MM-DD, exclusive). */
  before?: string;
  /** The day the email should be about. */
  aboutDay?: string;
}

export type Relaxation = "about_day_window" | "generic_words" | "wider_dates" | "sender_as_text";

/** How far before the day it's about a notice may have arrived. */
export const ABOUT_DAY_LOOKBACK = 14;

/** Words of the request, not of the email: they only make a literal search miss. */
const GENERIC =
  /(?<!\p{L})(clases?|correos?|mails?|e-?mails?|mensajes?|avisos?|notificaci[oó]n(es)?|hoy|ma[ñn]ana|ayer|pasado|semana|sobre|para|acerca|del?|la|las|los|el|un|una|unos|unas|y|o|que|si|hay|alg[uú]n|alguno|today|tomorrow|yesterday|class(es)?|emails?|messages?|about|for|the|a|an|any|of|on)(?!\p{L})/giu;

const words = (s: string) => s.replace(GENERIC, " ").replace(/\s+/g, " ").trim();

/**
 * The searches to try, in order, until one finds something. The first is the request itself
 * (with an `aboutDay` turned into the window its notice would have arrived in).
 */
export function searchLadder<T extends SearchShape>(q: T): { query: T; relaxed: Relaxation[] }[] {
  const first: T = { ...q };
  const relaxed: Relaxation[] = [];
  if (q.aboutDay && !q.after && !q.before) {
    first.after = addDays(q.aboutDay, -ABOUT_DAY_LOOKBACK);
    first.before = addDays(q.aboutDay, 1);
    relaxed.push("about_day_window");
  }
  const steps: { query: T; relaxed: Relaxation[] }[] = [{ query: first, relaxed: [...relaxed] }];
  let current = first;
  const push = (next: T, why: Relaxation) => {
    relaxed.push(why);
    current = next;
    steps.push({ query: next, relaxed: [...relaxed] });
  };
  const fewer = current.text ? words(current.text) : "";
  if (current.text && fewer !== current.text.trim())
    push({ ...current, text: fewer || undefined }, "generic_words");
  if (current.after)
    push({ ...current, after: addDays(current.after, -ABOUT_DAY_LOOKBACK) }, "wider_dates");
  if (current.from)
    push(
      { ...current, from: undefined, text: [current.text, current.from].filter(Boolean).join(" ") },
      "sender_as_text",
    );
  return steps;
}

const MONTHS_ES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
const MONTHS_EN = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const DAYS_ES = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
const DAYS_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");

/**
 * Whether a text names a day ("19/10", "lunes 19", "19 de octubre", "Oct 19", "Monday 19"):
 * what lets ELISE say "this notice is about Monday", not "about the day you asked".
 */
export function mentionsDay(text: string, day: string): boolean {
  const t = fold(text);
  const [, m, d] = day.split("-").map(Number) as [number, number, number];
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const dd = String(d);
  const mm = String(m);
  const patterns = [
    new RegExp(`(?<!\\d)0?${dd}[/.-]0?${mm}(?!\\d)`),
    new RegExp(`(?<!\\d)0?${dd}\\s+de\\s+${MONTHS_ES[m - 1]}`),
    new RegExp(`${DAYS_ES[weekday]}\\s+0?${dd}(?!\\d)`),
    new RegExp(`${MONTHS_EN[m - 1]!.slice(0, 3)}\\w*\\.?\\s+0?${dd}(?!\\d)`),
    new RegExp(`(?<!\\d)0?${dd}\\s+${MONTHS_EN[m - 1]!.slice(0, 3)}`),
    new RegExp(`${DAYS_EN[weekday]}\\s+0?${dd}(?!\\d)`),
  ];
  return patterns.some((p) => p.test(t));
}
