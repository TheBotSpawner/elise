import { visualizationSpec, type VisualizationSpec } from "./visualization";

/**
 * Visualization Planner (ADR-027). The model says WHAT the evidence is (sourced observations)
 * and what it wants to show (intent); this code decides HOW — deterministically:
 *
 *   provenance → comparability → data shape → chart family → reference/deltas → stats → spec
 *
 * No numbers are invented, no point without a source is drawn, values with different units or
 * horizons are never put on one scale, and a chart the data can't honestly support is refused
 * with a reason (a table is better than a misleading chart).
 */

export type VizIntent = "auto" | "compare" | "trend" | "distribution" | "range" | "progress";
export type ChartPreference = "auto" | "bar" | "line" | "dot" | "range" | "table" | "pie" | "kpi";
export type ObservationKind =
  "actual" | "estimate" | "target" | "low" | "base" | "high" | "scenario" | "share";

export interface Observation {
  label: string;
  value: number;
  /** "2025", "2025-03", "2025-Q4", "2025-10-02": a point in time (makes the data temporal). */
  time?: string;
  /** Which series it belongs to when several are compared over time. */
  series?: string;
  unit?: string;
  horizon?: string;
  kind?: ObservationKind;
  /** A URL or Surface handle ELISE actually has on screen. */
  source?: string;
  confidence?: "confirmed" | "reported" | "inferred";
}

export interface PlanInput {
  intent: VizIntent;
  title: string;
  subtitle?: string;
  metric: {
    name: string;
    unit?: string;
    format: "number" | "currency" | "percent" | "count" | "hours";
    currency?: string;
  };
  horizon?: string;
  observations: Observation[];
  reference?: { label: string; value: number; source?: string; unit?: string };
  preference?: { chart?: ChartPreference; sort?: "asc" | "desc" | "none"; exclude?: string[] };
  locale: "es" | "en";
}

export type DataShape =
  "single" | "category" | "time" | "range" | "part_of_whole" | "heterogeneous";

export interface Stats {
  count: number;
  min: number;
  max: number;
  median: number;
  mean: number;
}

export type PlanResult =
  | {
      ok: true;
      spec: VisualizationSpec;
      shape: DataShape;
      /** Points left out, and why (said to the user when it matters). */
      dropped: { label: string; reason: "unsourced" | "not_comparable" | "excluded" }[];
      /** Why a requested chart wasn't used, in the user's language. */
      notice: string | null;
      stats: Stats | null;
      /** Deterministic facts the narrative may use (ranges, deltas) — never computed by the model. */
      facts: string[];
    }
  | { ok: false; reason: string };

/** Known provenance: URL or Surface handle → title. */
export type KnownSources = ReadonlyMap<string, string>;

const norm = (s: string) => s.trim().toLowerCase();

export function planVisualization(input: PlanInput, known: KnownSources): PlanResult {
  const es = input.locale === "es";
  const dropped: Extract<PlanResult, { ok: true }>["dropped"] = [];
  const excluded = new Set((input.preference?.exclude ?? []).map(norm));

  // 1. Provenance: only points whose source ELISE actually holds.
  let obs = input.observations.filter((o) => {
    if (excluded.has(norm(o.label))) {
      dropped.push({ label: o.label, reason: "excluded" });
      return false;
    }
    if (!o.source || !known.has(o.source)) {
      dropped.push({ label: o.label, reason: "unsourced" });
      return false;
    }
    return Number.isFinite(o.value);
  });
  if (!obs.length)
    return {
      ok: false,
      reason: es
        ? "No hay datos con fuente verificable para graficar."
        : "There is no data with a verifiable source to chart.",
    };

  // 2. Comparability: one unit; one horizon unless the data is a time series.
  const unitOf = (o: Observation) => norm(o.unit ?? input.metric.unit ?? "");
  const horizonOf = (o: Observation) => norm(o.horizon ?? input.horizon ?? "");
  const temporal = obs.filter((o) => o.time).length >= 2 && obs.every((o) => o.time);
  const keyOf = (o: Observation) => (temporal ? unitOf(o) : `${unitOf(o)}|${horizonOf(o)}`);
  const groups = new Map<string, Observation[]>();
  for (const o of obs) groups.set(keyOf(o), [...(groups.get(keyOf(o)) ?? []), o]);
  const main = [...groups.values()].sort((a, b) => b.length - a.length)[0]!;
  if (groups.size > 1) {
    // Mixed metrics with nothing dominant: a table shows them honestly side by side.
    if (main.length < 2 && obs.length >= 2)
      return table(input, obs, known, dropped, "heterogeneous");
    for (const o of obs)
      if (!main.includes(o)) dropped.push({ label: o.label, reason: "not_comparable" });
    obs = main;
  }

  // 3. Data shape.
  const scenarioKinds = new Set<ObservationKind>(["low", "base", "high", "scenario"]);
  const shape: DataShape =
    obs.length === 1
      ? "single"
      : temporal
        ? "time"
        : obs.filter((o) => o.kind && scenarioKinds.has(o.kind)).length >= 2 ||
            input.intent === "range"
          ? "range"
          : obs.every((o) => o.kind === "share") ||
              (input.intent === "distribution" && sumsToWhole(obs, input.metric.format))
            ? "part_of_whole"
            : "category";

  // 4. Chart family: the data decides; a requested chart is honored only when it's honest.
  const allowed: Record<DataShape, ChartPreference[]> = {
    single: ["kpi", "table"],
    time: ["line", "bar", "table"],
    category: ["dot", "bar", "table"],
    range: ["range", "dot", "table"],
    part_of_whole: ["pie", "bar", "table"],
    heterogeneous: ["table"],
  };
  const wanted = input.preference?.chart ?? "auto";
  let notice: string | null = null;
  let chart: ChartPreference = defaultChart(shape, obs, input.reference);
  if (wanted !== "auto") {
    if (allowed[shape].includes(wanted)) chart = wanted;
    else notice = refusal(wanted, shape, es);
  }
  if (shape === "category" && obs.length > 12) chart = "table";

  const stats = shape === "time" || shape === "single" ? null : statsOf(obs.map((o) => o.value));
  const facts: string[] = [];
  const fmt = (v: number) => v.toLocaleString(es ? "es-AR" : "en-US", { maximumFractionDigits: 2 });
  if (stats && stats.count >= 2)
    facts.push(`${es ? "rango" : "range"} ${fmt(stats.min)}–${fmt(stats.max)}`);
  if (stats && stats.count >= 3) facts.push(`${es ? "mediana" : "median"} ${fmt(stats.median)}`);

  // 5. Reference (same unit only) and deterministic deltas.
  const ref =
    input.reference &&
    known.has(input.reference.source ?? "") &&
    norm(input.reference.unit ?? input.metric.unit ?? "") === unitOf(obs[0]!)
      ? input.reference
      : null;
  if (input.reference && !ref)
    dropped.push({
      label: input.reference.label,
      reason:
        input.reference.source && known.has(input.reference.source)
          ? "not_comparable"
          : "unsourced",
    });
  const pct = (v: number) =>
    ref && ref.value !== 0 ? round1(((v - ref.value) / Math.abs(ref.value)) * 100) : undefined;
  if (ref && stats) {
    const lo = pct(stats.min);
    const hi = pct(stats.max);
    if (lo !== undefined && hi !== undefined)
      facts.push(
        `${es ? "frente a" : "vs"} ${ref.label} (${fmt(ref.value)}): ${lo > 0 ? "+" : ""}${lo}% ${es ? "a" : "to"} ${hi > 0 ? "+" : ""}${hi}%`,
      );
  }

  // 6. Provenance list (one entry per source actually used).
  const sources: { title: string; url: string | null }[] = [];
  const indexOf = new Map<string, number>();
  const sourceIndex = (s: string | undefined) => {
    if (!s) return undefined;
    const seen = indexOf.get(s);
    if (seen !== undefined) return seen;
    if (sources.length >= 12) return undefined;
    sources.push({
      title: (known.get(s) ?? s).slice(0, 120),
      url: /^https:\/\/|^\//.test(s) ? s : null,
    });
    indexOf.set(s, sources.length - 1);
    return sources.length - 1;
  };

  const base = {
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    format: {
      kind: input.metric.format,
      ...(input.metric.currency ? { currency: input.metric.currency.toUpperCase() } : {}),
    },
  };
  const refSpec = ref
    ? {
        reference: {
          value: ref.value,
          label: clip(ref.label, 60),
          source: sourceIndex(ref.source),
        },
      }
    : {};
  const sortRows = <T extends { value: number }>(rows: T[]) => {
    const sort = input.preference?.sort ?? "none";
    return sort === "none"
      ? rows
      : [...rows].sort((a, b) => (sort === "asc" ? a.value - b.value : b.value - a.value));
  };

  let spec: unknown;
  if (chart === "table") return table(input, obs, known, dropped, shape, notice);
  if (chart === "kpi") {
    const o = obs[0]!;
    spec = {
      type: "kpi",
      ...base,
      value: o.value,
      ...(ref ? { previous: ref.value, previousLabel: clip(ref.label, 60) } : {}),
      source: clip(known.get(o.source!) ?? "", 160) || undefined,
    };
  } else if (shape === "time") {
    const times = [...new Set(obs.map((o) => o.time!))].sort((a, b) => timeKey(a) - timeKey(b));
    const seriesNames = [...new Set(obs.map((o) => o.series ?? input.metric.name))].slice(0, 3);
    spec = {
      type: chart === "bar" ? "bar" : "line",
      ...base,
      x: times.map((t) => clip(t, 60)),
      // Missing points stay missing: no interpolation, no invented dates.
      series: seriesNames.slice(0, chart === "bar" ? 2 : 3).map((name) => ({
        name: clip(name, 60),
        values: times.map(
          (t) =>
            obs.find((o) => o.time === t && (o.series ?? input.metric.name) === name)?.value ??
            null,
        ),
      })),
      ...refSpec,
    };
  } else if (chart === "range") {
    spec = {
      type: "range",
      ...base,
      scenarios: sortRows(obs)
        .slice(0, 8)
        .map((o) => ({
          label: clip(o.label, 60),
          value: o.value,
          kind: o.kind && scenarioKinds.has(o.kind) ? o.kind : "scenario",
          source: sourceIndex(o.source),
        })),
      ...refSpec,
    };
  } else if (chart === "pie") {
    spec = {
      type: "distribution",
      ...base,
      rows: obs
        .slice(0, 12)
        .map((o) => ({ label: clip(o.label, 60), value: Math.max(0, o.value) })),
    };
  } else if (chart === "bar") {
    spec = {
      type: "hbar",
      ...base,
      rows: sortRows(obs)
        .slice(0, 12)
        .map((o) => ({ label: clip(o.label, 60), value: Math.max(0, o.value) })),
    };
  } else {
    spec = {
      type: "dot",
      ...base,
      rows: sortRows(obs)
        .slice(0, 12)
        .map((o) => ({
          label: clip(o.label, 60),
          value: o.value,
          ...(ref ? { delta: round1(o.value - ref.value), deltaPct: pct(o.value) } : {}),
          source: sourceIndex(o.source),
          ...(o.confidence === "inferred" ? { uncertain: true } : {}),
        })),
      ...refSpec,
    };
  }
  const withSources = { ...(spec as object), ...(sources.length ? { sources } : {}) };
  const parsed = visualizationSpec.safeParse(withSources);
  if (!parsed.success)
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "invalid chart" };
  return { ok: true, spec: parsed.data, shape, dropped, notice, stats, facts };
}

function defaultChart(
  shape: DataShape,
  obs: Observation[],
  reference: PlanInput["reference"],
): ChartPreference {
  switch (shape) {
    case "single":
      return "kpi";
    case "time":
      return "line";
    case "range":
      return "range";
    case "part_of_whole":
      return "pie";
    case "heterogeneous":
      return "table";
    case "category": {
      // Close values read better as dots on one scale (bars from zero hide the differences);
      // a reference value is a natural dot comparison too.
      const s = statsOf(obs.map((o) => o.value));
      const close = s.median !== 0 && (s.max - s.min) / Math.abs(s.median) < 0.35;
      return reference || close || obs.some((o) => o.value < 0) ? "dot" : "bar";
    }
  }
}

function refusal(wanted: ChartPreference, shape: DataShape, es: boolean): string {
  if (wanted === "line" && shape !== "time")
    return es
      ? "No son puntos en el tiempo sino categorías: una línea sugeriría una evolución que no existe, así que lo muestro comparado."
      : "These are categories, not points in time: a line would suggest a trend that doesn't exist, so I'm showing a comparison.";
  if (wanted === "pie")
    return es
      ? "Los valores no forman un total, así que una torta sería engañosa."
      : "The values don't add up to a whole, so a pie would be misleading.";
  if (wanted === "range")
    return es
      ? "No hay escenarios ni rango en los datos, así que lo muestro comparado."
      : "The data has no scenarios or range, so I'm showing a comparison.";
  return es
    ? "Ese tipo de gráfico no representa bien estos datos; uso el que corresponde."
    : "That chart type doesn't represent this data well; I'm using the one that does.";
}

function table(
  input: PlanInput,
  obs: Observation[],
  known: KnownSources,
  dropped: Extract<PlanResult, { ok: true }>["dropped"],
  shape: DataShape,
  notice: string | null = null,
): PlanResult {
  const es = input.locale === "es";
  const fmt = (v: number) => v.toLocaleString(es ? "es-AR" : "en-US", { maximumFractionDigits: 2 });
  const spec = visualizationSpec.safeParse({
    type: "table",
    title: input.title,
    ...(input.subtitle ? { subtitle: input.subtitle } : {}),
    columns: [
      { label: es ? "Qué" : "What" },
      { label: es ? "Valor" : "Value", numeric: true },
      { label: es ? "Unidad" : "Unit" },
      { label: es ? "Horizonte" : "Horizon" },
      { label: es ? "Fuente" : "Source" },
    ],
    rows: obs
      .slice(0, 12)
      .map((o) => [
        clip(o.label, 80),
        fmt(o.value),
        clip(o.unit ?? input.metric.unit ?? "", 80),
        clip(o.horizon ?? o.time ?? input.horizon ?? "", 80),
        clip(known.get(o.source ?? "") ?? "", 80),
      ]),
    ...(obs.length > 12
      ? { note: es ? `Mostrando 12 de ${obs.length}.` : `Showing 12 of ${obs.length}.` }
      : {}),
  });
  if (!spec.success) return { ok: false, reason: spec.error.issues[0]?.message ?? "invalid table" };
  return { ok: true, spec: spec.data, shape, dropped, notice, stats: null, facts: [] };
}

function sumsToWhole(obs: Observation[], format: PlanInput["metric"]["format"]): boolean {
  const sum = obs.reduce((a, o) => a + o.value, 0);
  return format === "percent" && sum >= 95 && sum <= 105;
}

export function statsOf(values: number[]): Stats {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return {
    count: v.length,
    min: v[0]!,
    max: v.at(-1)!,
    median: v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2,
    mean: round1(v.reduce((a, b) => a + b, 0) / v.length),
  };
}

/** Sortable value of a time label: year, year-month, year-quarter or date. */
export function timeKey(t: string): number {
  const q = /^(\d{4})-?Q([1-4])$/i.exec(t.trim());
  if (q) return Date.UTC(Number(q[1]), (Number(q[2]) - 1) * 3, 1);
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(t.trim());
  if (m) return Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1);
  const d = Date.parse(t);
  return Number.isNaN(d) ? Number.MAX_SAFE_INTEGER : d;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
