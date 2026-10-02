import {
  TEMPORAL_WHEN,
  visualizationSpec,
  type TemporalKind,
  type TemporalView,
  type VisualizationSpec,
} from "./visualization";

/**
 * Temporal planner (ADR-028): the model extracts dated events from the evidence (each with its
 * source); this code validates the dates, keeps provenance, surfaces conflicting sources and
 * picks the representation from the events' density — never from the wording:
 *
 *   one day of timed events      → agenda
 *   several meaningful durations → intervals (Gantt-like)
 *   many dates within ~3 months  → calendar
 *   sparse milestones over time  → timeline
 *
 * Fewer than three dates read better as a sentence, unless the user asked to see them.
 */

export interface ResolvedSource {
  title: string;
  url: string | null;
  excerpt?: string;
}

export interface TemporalEventInput {
  title: string;
  start: string;
  end?: string;
  kind?: TemporalKind;
  importance?: "high" | "normal" | "low";
  detail?: string;
  recurrence?: string;
  /** Already resolved by the caller; null when ELISE doesn't hold the source. */
  source: ResolvedSource | null;
  confidence?: "confirmed" | "reported" | "inferred";
}

export interface TemporalFocus {
  kinds?: TemporalKind[];
  from?: string;
  to?: string;
}

export interface TemporalPlanInput {
  title: string;
  subtitle?: string;
  events: TemporalEventInput[];
  view: TemporalView | "auto";
  focus?: TemporalFocus;
  /** The user's local date (YYYY-MM-DD). */
  today: string;
  /** The user asked to see dates (a schedule, a calendar): even two are worth showing. */
  explicit: boolean;
  locale: "es" | "en";
}

export type TemporalDrop = {
  title: string;
  reason: "unsourced" | "invalid_date" | "invalid_range" | "over_limit";
};

export type TemporalPlan =
  | {
      ok: true;
      spec: Extract<VisualizationSpec, { type: "temporal" }>;
      view: TemporalView;
      dropped: TemporalDrop[];
      /** Titles another source dates differently: both are kept and flagged. */
      conflicts: string[];
      notice: string | null;
      /** Deterministic facts for the narrative (span, next date, counts). */
      facts: string[];
    }
  | { ok: false; reason: string };

const MAX_EVENTS = 40;
const DAY_MS = 86_400_000;

/** A valid calendar value → its start instant (UTC) and precision; null when it isn't one. */
export function parseWhen(raw: string): { at: number; precision: "month" | "day" | "time" } | null {
  const v = raw.trim();
  if (!TEMPORAL_WHEN.test(v)) return null;
  const [y, m, d] = [Number(v.slice(0, 4)), Number(v.slice(5, 7)), Number(v.slice(8, 10) || 1)];
  const hh = v.length > 10 ? Number(v.slice(11, 13)) : 0;
  const mm = v.length > 10 ? Number(v.slice(14, 16)) : 0;
  if (hh > 23 || mm > 59) return null;
  const at = Date.UTC(y, m - 1, d, hh, mm);
  const back = new Date(at);
  // 2026-02-30 rolls over to March: not a real date.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d)
    return null;
  return { at, precision: v.length === 7 ? "month" : v.length === 10 ? "day" : "time" };
}

/** The last instant a value covers: a month runs to its last day, a day to its end. */
function endOf(raw: string): number {
  const p = parseWhen(raw)!;
  if (p.precision === "month") {
    const d = new Date(p.at);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1;
  }
  return p.precision === "day" ? p.at + DAY_MS - 1 : p.at;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** What deserves emphasis when the model didn't say: exams, deadlines and deliveries. */
const DEFAULT_HIGH = new Set<TemporalKind>(["exam", "deadline", "delivery"]);

export function planTemporal(input: TemporalPlanInput): TemporalPlan {
  const es = input.locale === "es";
  const dropped: TemporalDrop[] = [];

  // 1. Dates are validated in code, provenance is required.
  type Valid = TemporalEventInput & { from: number; to: number; precision: string };
  const valid: Valid[] = [];
  for (const e of input.events) {
    const start = parseWhen(e.start);
    const end = e.end ? parseWhen(e.end) : null;
    if (!start || (e.end && !end)) {
      dropped.push({ title: e.title, reason: "invalid_date" });
      continue;
    }
    if (e.end && endOf(e.end) < start.at) {
      dropped.push({ title: e.title, reason: "invalid_range" });
      continue;
    }
    if (!e.source) {
      dropped.push({ title: e.title, reason: "unsourced" });
      continue;
    }
    valid.push({
      ...e,
      // "22–23 Sep" stays a range; an end equal to the start is just the day.
      ...(e.end && e.end !== e.start ? { end: e.end } : { end: undefined }),
      from: start.at,
      to: e.end ? endOf(e.end) : endOf(e.start),
      precision: start.precision,
    });
  }

  // 2. The same event twice (two passages, two calls) is one; different dates are a conflict.
  const unique: Valid[] = [];
  for (const e of valid)
    if (
      !unique.some((u) => norm(u.title) === norm(e.title) && u.start === e.start && u.end === e.end)
    )
      unique.push(e);
  const conflicts = new Set<string>();
  for (const a of unique)
    for (const b of unique)
      if (
        a !== b &&
        norm(a.title) === norm(b.title) &&
        a.start !== b.start &&
        (a.source!.url ?? a.source!.title) !== (b.source!.url ?? b.source!.title)
      )
        conflicts.add(a.title);

  unique.sort((a, b) => a.from - b.from || a.to - b.to);
  const events = unique.slice(0, MAX_EVENTS);
  for (const e of unique.slice(MAX_EVENTS)) dropped.push({ title: e.title, reason: "over_limit" });
  if (!events.length)
    return {
      ok: false,
      reason: es
        ? "No hay fechas válidas con fuente verificable para mostrar."
        : "There are no valid dates with a verifiable source to show.",
    };
  if (events.length < 3 && !input.explicit && input.view === "auto")
    return {
      ok: false,
      reason: es
        ? "Con una o dos fechas, una frase es más clara que un gráfico: decilas en el texto."
        : "One or two dates read better in a sentence: say them in the text.",
    };

  // 3. Focus narrows what is shown, deterministically ("solo los parciales", "septiembre"),
  //    and the density of what is shown decides the representation.
  const focus = cleanFocus(input.focus);
  const inFocus = events.filter((e) => matches(e, focus));
  const basis = inFocus.length ? inFocus : events;
  const first = basis[0]!.from;
  const last = Math.max(...basis.map((e) => e.to));
  const spanDays = (last - first) / DAY_MS;
  const timed = basis.filter((e) => e.precision === "time").length;
  const intervals = basis.filter((e) => e.end && e.to - e.from >= 2 * DAY_MS).length;
  const months = new Set(basis.map((e) => e.start.slice(0, 7))).size;
  const auto: TemporalView =
    timed >= basis.length * 0.8 && spanDays <= 7
      ? "agenda"
      : intervals >= 2 && intervals >= basis.length * 0.4
        ? "intervals"
        : basis.length >= 5 && months <= 3 && basis.length / months >= 2.5
          ? "calendar"
          : basis.length < 3
            ? "list"
            : "timeline";
  let view = auto;
  let notice: string | null = null;
  if (input.view !== "auto") {
    const fits: Record<TemporalView, boolean> = {
      timeline: true,
      list: true,
      calendar: spanDays <= 186,
      agenda: spanDays <= 14,
      intervals: basis.some((e) => e.end),
    };
    if (fits[input.view]) view = input.view;
    else
      notice =
        input.view === "intervals"
          ? es
            ? "Ninguna fecha tiene duración, así que no hay barras que dibujar: lo muestro como línea de tiempo."
            : "None of the dates has a duration, so there are no bars to draw: showing a timeline."
          : es
            ? "Las fechas abarcan demasiado tiempo para esa vista; uso la que se lee mejor."
            : "The dates span too long for that view; using the one that reads best.";
  }

  // 4. Provenance list, one entry per source.
  const sources: ResolvedSource[] = [];
  const sourceIndex = (s: ResolvedSource) => {
    const key = `${s.url ?? ""}|${s.title}|${s.excerpt ?? ""}`;
    const i = sources.findIndex((x) => `${x.url ?? ""}|${x.title}|${x.excerpt ?? ""}` === key);
    if (i >= 0) return i;
    if (sources.length >= 12) {
      // Past twelve, the document is still credited even if the passage isn't.
      const doc = sources.findIndex((x) => x.url === s.url && x.title === s.title);
      return doc >= 0 ? doc : undefined;
    }
    sources.push(s);
    return sources.length - 1;
  };

  const spec = visualizationSpec.safeParse({
    type: "temporal",
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    view,
    today: input.today,
    ...(focus ? { focus } : {}),
    events: events.map((e) => ({
      title: clip(e.title, 100),
      start: e.start,
      ...(e.end ? { end: e.end } : {}),
      kind: e.kind ?? "general",
      importance: e.importance ?? (DEFAULT_HIGH.has(e.kind ?? "general") ? "high" : "normal"),
      ...(e.detail ? { detail: clip(e.detail, 160) } : {}),
      ...(e.recurrence ? { recurrence: clip(e.recurrence, 60) } : {}),
      source: sourceIndex({
        title: clip(e.source!.title, 120),
        url: e.source!.url,
        ...(e.source!.excerpt ? { excerpt: clip(e.source!.excerpt, 300) } : {}),
      }),
      ...(conflicts.has(e.title) ? { conflict: true } : {}),
      ...(e.confidence === "inferred" ? { uncertain: true } : {}),
    })),
    sources: sources.map((s) => ({
      title: s.title,
      url: s.url && (/^https:\/\//.test(s.url) || s.url.startsWith("/")) ? s.url : null,
      ...(s.excerpt ? { excerpt: s.excerpt } : {}),
    })),
  });
  if (!spec.success)
    return { ok: false, reason: spec.error.issues[0]?.message ?? "invalid temporal view" };
  if (spec.data.type !== "temporal") return { ok: false, reason: "invalid temporal view" };

  // 5. Facts the narrative may use instead of reading every date.
  const shown = inFocus.length ? inFocus : events;
  const fmt = new Intl.DateTimeFormat(es ? "es-AR" : "en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const label = (e: Valid) =>
    e.precision === "month"
      ? new Intl.DateTimeFormat(es ? "es-AR" : "en-US", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(e.from)
      : e.end
        ? `${fmt.format(e.from)}–${fmt.format(parseWhen(e.end)!.at)}`
        : fmt.format(e.from);
  const today = parseWhen(input.today)?.at ?? 0;
  const next = shown.find((e) => e.to >= today);
  const facts = [
    `${shown.length} ${es ? "fechas" : "dates"}: ${label(shown[0]!)} → ${label(shown.at(-1)!)}`,
    next
      ? `${es ? "próxima" : "next"}: ${next.title} (${label(next)})`
      : es
        ? "todas las fechas ya pasaron"
        : "every date is in the past",
  ];
  const high = shown.filter(
    (e) => (e.importance ?? (DEFAULT_HIGH.has(e.kind ?? "general") ? "high" : "normal")) === "high",
  );
  if (high.length && high.length < shown.length)
    facts.push(
      `${es ? "destacadas" : "key"}: ${high.map((e) => `${e.title} (${label(e)})`).join("; ")}`,
    );
  if (focus && !inFocus.length)
    facts.push(es ? "ninguna fecha coincide con el filtro" : "no date matches the filter");
  return {
    ok: true,
    spec: spec.data,
    view,
    dropped,
    conflicts: [...conflicts],
    notice,
    facts,
  };
}

function cleanFocus(f: TemporalFocus | undefined): TemporalFocus | undefined {
  if (!f) return undefined;
  const out: TemporalFocus = {};
  if (f.kinds?.length) out.kinds = [...new Set(f.kinds)];
  if (f.from && parseWhen(f.from)?.precision === "day") out.from = f.from;
  if (f.to && parseWhen(f.to)?.precision === "day") out.to = f.to;
  return Object.keys(out).length ? out : undefined;
}

/** Whether an event is inside a focus (kinds, and overlapping the from–to window). */
export function matches(
  e: { kind?: TemporalKind; start: string; end?: string },
  focus: TemporalFocus | undefined,
): boolean {
  if (!focus) return true;
  if (focus.kinds?.length && !focus.kinds.includes(e.kind ?? "general")) return false;
  const from = parseWhen(e.start)?.at ?? 0;
  const to = endOf(e.end ?? e.start);
  if (focus.from && to < parseWhen(focus.from)!.at) return false;
  if (focus.to && from > endOf(focus.to)) return false;
  return true;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
