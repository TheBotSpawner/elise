import { visualizationSpec, type VisualizationSpec } from "./visualization";

/**
 * Visualization Planner (ADR-027, ADR-029). The model says WHAT the evidence is (sourced
 * observations) and what it wants to show (intent); this code decides HOW — deterministically,
 * preferring the familiar chart that fits the data's shape over anything novel:
 *
 *   provenance → comparability → data shape → chart → reference/deltas → stats → spec
 *
 *   one value                       → KPI
 *   categories                      → bars (horizontal for long labels or many)
 *   categories + a sourced reference → dots with the reference marker and deltas
 *   parts of a true whole, ≤ 6      → donut; more → horizontal bars
 *   points in time                  → line (multi-line for series; area on request)
 *   real open/high/low/close        → candlestick
 *   two numeric variables           → scatter
 *   raw values (frequency)          → histogram (bins computed here)
 *   start + additive changes        → waterfall (end computed here)
 *   scenarios                       → range
 *   heterogeneous or > 12 categories → table
 *
 * No numbers are invented, no point without a source is drawn, values with different units or
 * horizons are never put on one scale, and a chart the data can't honestly support is refused
 * with a reason (a table is better than a misleading chart).
 */

export type VizIntent =
  | "auto"
  | "compare"
  | "trend"
  | "distribution"
  | "range"
  | "progress"
  | "relationship"
  | "frequency"
  | "contribution";
export type ChartPreference =
  | "auto"
  | "bar"
  | "hbar"
  | "line"
  | "area"
  | "dot"
  | "range"
  | "table"
  | "pie"
  | "donut"
  | "kpi"
  | "scatter"
  | "histogram"
  | "waterfall"
  | "candlestick";
export type ObservationKind =
  | "actual"
  | "estimate"
  | "target"
  | "low"
  | "base"
  | "high"
  | "scenario"
  | "share"
  | "start"
  | "delta"
  | "end";

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
  /** The other numeric variable, for a relationship (value is y). */
  x?: number;
  /** A period's real open/high/low (value is the close). */
  open?: number;
  high?: number;
  low?: number;
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
  /** The x variable of a relationship ("Revenue"). */
  xMetric?: { name: string; format?: "number" | "currency" | "percent" | "count" | "hours" };
  observations: Observation[];
  reference?: { label: string; value: number; source?: string; unit?: string };
  preference?: { chart?: ChartPreference; sort?: "asc" | "desc" | "none"; exclude?: string[] };
  locale: "es" | "en";
}

export type DataShape =
  | "single"
  | "category"
  | "time"
  | "ohlc"
  | "range"
  | "part_of_whole"
  | "relationship"
  | "frequency"
  | "contribution"
  | "heterogeneous";

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

/** Charts each shape can honestly take; the first is the default unless a rule says otherwise. */
const ALLOWED: Record<DataShape, ChartPreference[]> = {
  single: ["kpi", "table"],
  time: ["line", "area", "bar", "table"],
  ohlc: ["candlestick", "line", "table"],
  category: ["bar", "hbar", "dot", "table"],
  range: ["range", "dot", "table"],
  part_of_whole: ["donut", "pie", "hbar", "bar", "table"],
  relationship: ["scatter", "table"],
  frequency: ["histogram", "table"],
  contribution: ["waterfall", "table"],
  heterogeneous: ["table"],
};

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

  // Points in time, stated or recognisable from the labels ("2024", "oct 2025", "2025-10-02").
  const when = (o: Observation) => o.time ?? (timeLabel(o.label) !== null ? o.label : undefined);
  const temporal = obs.length >= 2 && obs.every((o) => when(o) !== undefined);

  // 2. Comparability: one unit; one horizon unless the data is a time series.
  const unitOf = (o: Observation) => norm(o.unit ?? input.metric.unit ?? "");
  const horizonOf = (o: Observation) => norm(o.horizon ?? input.horizon ?? "");
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

  // 3. Data shape: what the evidence IS, from its structure and the stated intent.
  const scenarioKinds = new Set<ObservationKind>(["low", "base", "high", "scenario"]);
  const hasOhlc = obs.every((o) => o.open != null && o.high != null && o.low != null);
  const shape: DataShape =
    input.intent === "frequency" && obs.length >= 5
      ? "frequency"
      : input.intent === "contribution" || obs.some((o) => o.kind === "delta")
        ? "contribution"
        : (input.intent === "relationship" || obs.every((o) => o.x != null)) && obs.length >= 3
          ? "relationship"
          : obs.length === 1
            ? "single"
            : temporal && hasOhlc
              ? "ohlc"
              : temporal
                ? "time"
                : obs.filter((o) => o.kind && scenarioKinds.has(o.kind)).length >= 2 ||
                    input.intent === "range"
                  ? "range"
                  : obs.every((o) => o.kind === "share") ||
                      (input.intent === "distribution" && sumsToWhole(obs, input.metric.format))
                    ? "part_of_whole"
                    : "category";

  // 4. Chart: the data decides; a requested chart is honored only when it's honest.
  const wanted = input.preference?.chart ?? "auto";
  let notice: string | null = null;
  let chart: ChartPreference = defaultChart(shape, obs, input.reference);
  if (wanted !== "auto") {
    if (ALLOWED[shape].includes(wanted)) chart = wanted;
    else notice = refusal(wanted, shape, es);
  }
  if (chart === "pie") chart = "donut";
  if (chart === "donut" && obs.length > 6) chart = "hbar";
  if ((shape === "category" || shape === "part_of_whole") && obs.length > 12) chart = "table";

  const stats =
    shape === "time" || shape === "single" || shape === "ohlc"
      ? null
      : statsOf(obs.map((o) => o.value));
  const facts: string[] = [];
  const fmt = (v: number) => v.toLocaleString(es ? "es-AR" : "en-US", { maximumFractionDigits: 2 });
  if (stats && stats.count >= 2 && shape !== "contribution")
    facts.push(`${es ? "rango" : "range"} ${fmt(stats.min)}–${fmt(stats.max)}`);
  if (stats && stats.count >= 3 && shape !== "contribution")
    facts.push(`${es ? "mediana" : "median"} ${fmt(stats.median)}`);

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
  // Points in time, in order (dated labels sorted; undated month names keep the given order).
  const ordered = () => {
    const keys = obs.map((o) => timeKey(when(o)!));
    return keys.every((k) => k !== Number.MAX_SAFE_INTEGER)
      ? [...obs].sort((a, b) => timeKey(when(a)!) - timeKey(when(b)!))
      : obs;
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
  } else if (chart === "candlestick") {
    const rows = ordered();
    spec = {
      type: "candlestick",
      ...base,
      x: rows.map((o) => clip(when(o)!, 60)),
      ohlc: rows.map((o) => ({ open: o.open!, high: o.high!, low: o.low!, close: o.value })),
    };
    facts.push(
      periodFact(
        rows.map((o) => when(o)!),
        rows.map((o) => o.value),
        es,
        fmt,
      ),
    );
  } else if (shape === "time" || shape === "ohlc") {
    const rows = ordered();
    const times = [...new Set(rows.map((o) => when(o)!))];
    const seriesNames = [...new Set(rows.map((o) => o.series ?? input.metric.name))].slice(0, 4);
    const series = seriesNames.slice(0, chart === "bar" ? 4 : 3).map((name) => ({
      name: clip(name, 60),
      // Missing points stay missing: no interpolation, no invented dates.
      values: times.map(
        (t) =>
          rows.find((o) => when(o) === t && (o.series ?? input.metric.name) === name)?.value ??
          null,
      ),
    }));
    spec = {
      type: chart === "bar" ? "bar" : chart === "area" ? "area" : "line",
      ...base,
      x: times.map((t) => clip(t, 60)),
      series,
      ...refSpec,
    };
    const first = series[0]!.values;
    facts.push(periodFact(times, first, es, fmt));
  } else if (chart === "scatter") {
    const pts = obs.filter((o) => o.x != null);
    spec = {
      type: "scatter",
      ...base,
      xLabel: clip(input.xMetric?.name ?? "x", 60),
      yLabel: clip(input.metric.name, 60),
      xFormat: { kind: input.xMetric?.format ?? "number" },
      points: pts.slice(0, 200).map((o) => ({
        label: clip(o.label, 60),
        x: o.x!,
        y: o.value,
        source: sourceIndex(o.source),
      })),
    };
    const r = correlation(pts.map((o) => [o.x!, o.value]));
    if (r !== null) facts.push(`${es ? "correlación" : "correlation"} r = ${r}`);
  } else if (chart === "histogram") {
    const bins = histogramBins(obs.map((o) => o.value));
    spec = { type: "histogram", ...base, bins, unitLabel: clip(input.metric.name, 60) };
    const top = [...bins].sort((a, b) => b.count - a.count)[0]!;
    facts.push(
      `${es ? "más frecuente" : "most common"}: ${fmt(top.from)}–${fmt(top.to)} (${top.count})`,
    );
  } else if (chart === "waterfall") {
    const plan = waterfallSteps(obs, input.reference ?? null, es);
    if (!plan)
      return {
        ok: false,
        reason: es
          ? "Una cascada necesita un valor inicial y los cambios: faltan datos."
          : "A waterfall needs a starting value and the changes: data is missing.",
      };
    spec = {
      type: "waterfall",
      ...base,
      steps: plan.steps.map((st) => ({ ...st, source: sourceIndex(st.source) })),
    };
    facts.push(...plan.facts.map((f) => f(fmt)));
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
  } else if (chart === "donut") {
    spec = {
      type: "donut",
      ...base,
      rows: [...obs]
        .sort((a, b) => b.value - a.value)
        .map((o) => ({ label: clip(o.label, 60), value: Math.max(0, o.value) })),
    };
  } else if (chart === "bar" && !obs.some((o) => o.value < 0)) {
    const rows = sortRows(obs).slice(0, 12);
    spec = {
      type: "bar",
      ...base,
      x: rows.map((o) => clip(o.label, 60)),
      series: [{ name: clip(input.metric.name, 60), values: rows.map((o) => o.value) }],
      ...refSpec,
    };
  } else if (chart === "hbar" && !obs.some((o) => o.value < 0)) {
    spec = {
      type: "hbar",
      ...base,
      rows: sortRows(obs)
        .slice(0, 12)
        .map((o) => ({
          label: clip(o.label, 60),
          value: o.value,
          source: sourceIndex(o.source),
          ...(o.confidence === "inferred" ? { uncertain: true } : {}),
        })),
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
    case "category": {
      // Against a sourced reference (current level, budget), dots on one scale show each
      // value's distance from it. Otherwise: plain bars — horizontal when labels are long or
      // there are many (they stay readable on a phone), vertical for a few short ones.
      if (reference) return "dot";
      // Values from several sources (research) keep each bar's source: horizontal bars show it.
      const sourced =
        new Set(obs.map((o) => o.source)).size > 1 || obs.some((o) => o.confidence === "inferred");
      const long = obs.some((o) => o.label.length > 12);
      return sourced || long || obs.length > 6 ? "hbar" : "bar";
    }
    case "part_of_whole":
      return obs.length <= 6 ? "donut" : "hbar";
    default:
      return ALLOWED[shape][0]!;
  }
}

function refusal(wanted: ChartPreference, shape: DataShape, es: boolean): string {
  if ((wanted === "line" || wanted === "area") && shape !== "time" && shape !== "ohlc")
    return es
      ? "No son puntos en el tiempo sino categorías: una línea sugeriría una evolución que no existe, así que lo muestro con barras."
      : "These are categories, not points in time: a line would suggest a trend that doesn't exist, so I'm showing bars.";
  if (wanted === "pie" || wanted === "donut")
    return es
      ? "Los valores no forman un total, así que una torta sería engañosa; los comparo con barras."
      : "The values don't add up to a whole, so a pie would be misleading; comparing them with bars.";
  if (wanted === "candlestick")
    return es
      ? "No tengo apertura, máximo y mínimo de cada período, así que no invento velas: lo muestro como línea."
      : "I don't have each period's open, high and low, so I won't invent candles: showing a line.";
  if (wanted === "scatter")
    return es
      ? "Para una dispersión hacen falta dos variables numéricas por punto; acá hay una."
      : "A scatter plot needs two numeric variables per point; there is one here.";
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

/** "From 7.400 (2024-01) to 8.100 (2025-01), +9,5%": the period stated, computed here. */
function periodFact(
  times: string[],
  values: (number | null)[],
  es: boolean,
  fmt: (v: number) => string,
): string {
  const first = values.findIndex((v) => v !== null);
  const last = values.findLastIndex((v) => v !== null);
  if (first < 0 || last <= first)
    return `${es ? "período" : "period"} ${times[0]} – ${times.at(-1)}`;
  const a = values[first]!;
  const b = values[last]!;
  const change = a !== 0 ? round1(((b - a) / Math.abs(a)) * 100) : null;
  return `${es ? "período" : "period"} ${times[first]} – ${times[last]}: ${fmt(a)} → ${fmt(b)}${
    change !== null ? ` (${change > 0 ? "+" : ""}${change}%)` : ""
  }`;
}

/**
 * Equal-width bins on round edges (Sturges' rule, 3–12 bins), counted here.
 * ponytail: Sturges suits the tens-to-hundreds of values ELISE charts; Freedman–Diaconis if
 * skewed, large samples become common.
 */
export function histogramBins(values: number[]): { from: number; to: number; count: number }[] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const k = Math.max(3, Math.min(12, Math.ceil(Math.log2(values.length) + 1)));
  const raw = (hi - lo || 1) / k;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
  const start = Math.floor(lo / step) * step;
  // The last bin includes the maximum.
  const n = Math.min(30, Math.max(2, Math.floor((hi - start) / step) + 1));
  const bins = Array.from({ length: n }, (_, i) => ({
    from: round6(start + i * step),
    to: round6(start + (i + 1) * step),
    count: 0,
  }));
  for (const v of values) {
    const i = Math.min(bins.length - 1, Math.floor((v - start) / step));
    bins[i]!.count++;
  }
  return bins;
}

/**
 * Start → additive changes → end, every step from the evidence; the end is computed, and if a
 * stated end disagrees the gap is shown as its own step — never silently absorbed.
 */
function waterfallSteps(
  obs: Observation[],
  reference: PlanInput["reference"] | null,
  es: boolean,
): {
  steps: { label: string; value: number; kind: "start" | "delta" | "end"; source?: string }[];
  facts: ((fmt: (v: number) => string) => string)[];
} | null {
  const start = obs.find((o) => o.kind === "start");
  const startValue = start?.value ?? reference?.value;
  if (startValue === undefined) return null;
  const deltas = obs.filter((o) => o.kind === "delta" || (!o.kind && o !== start));
  if (!deltas.length) return null;
  const computed = startValue + deltas.reduce((n, o) => n + o.value, 0);
  const stated = obs.find((o) => o.kind === "end");
  const gap = stated ? round6(stated.value - computed) : 0;
  const steps = [
    {
      label: clip(start?.label ?? reference!.label, 60),
      value: startValue,
      kind: "start" as const,
      source: start?.source ?? reference?.source,
    },
    ...deltas.slice(0, 13).map((o) => ({
      label: clip(o.label, 60),
      value: o.value,
      kind: "delta" as const,
      source: o.source,
    })),
    ...(gap !== 0
      ? [{ label: es ? "Sin explicar" : "Unexplained", value: gap, kind: "delta" as const }]
      : []),
    {
      label: clip(stated?.label ?? (es ? "Final" : "End"), 60),
      value: round6(computed + gap),
      kind: "end" as const,
      source: stated?.source,
    },
  ];
  const biggest = [...deltas].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0]!;
  return {
    steps,
    facts: [
      (fmt) => `${fmt(startValue)} → ${fmt(round6(computed + gap))}`,
      (fmt) =>
        `${es ? "mayor cambio" : "largest change"}: ${biggest.label} ${biggest.value > 0 ? "+" : ""}${fmt(biggest.value)}`,
    ],
  };
}

/** Pearson r, rounded to 2 decimals (null with no variation). */
function correlation(pairs: [number, number][]): number | null {
  const n = pairs.length;
  const mx = pairs.reduce((a, [x]) => a + x, 0) / n;
  const my = pairs.reduce((a, [, y]) => a + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx && syy ? Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100 : null;
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

const MONTHS: Record<string, number> = {
  ene: 1,
  jan: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  aug: 8,
  sep: 9,
  set: 9,
  oct: 10,
  nov: 11,
  dic: 12,
  dec: 12,
};

/**
 * A label that names a point in time — "2024", "2025-03", "2025-Q4", "Q4 2025", "2025-10-02",
 * "02/10/2025", "oct 2025", "octubre", "1 oct" — normalised to a sortable string, else null.
 * A plain category ("Bank of America", "Groceries") is never mistaken for a date.
 */
export function timeLabel(label: string): string | null {
  const t = label.trim().toLowerCase();
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(t) && Number(t.slice(0, 4)) > 1800) return t;
  const q = /^(?:(\d{4})[- ]?q([1-4])|q([1-4])[- ]?(\d{4}))$/.exec(t);
  if (q) return `${q[1] ?? q[4]}-Q${q[2] ?? q[3]}`;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (dmy && Number(dmy[2]) <= 12)
    return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  const word = /^(?:(\d{1,2})\s+(?:de\s+)?)?([a-zñ]{3})[a-zñ]*\.?(?:\s+(?:de\s+)?(\d{4}))?$/.exec(
    t,
  );
  if (word && MONTHS[word[2]!]) {
    const m = String(MONTHS[word[2]!]).padStart(2, "0");
    const d = word[1] ? `-${word[1].padStart(2, "0")}` : "";
    // Without a year the order can't be known from the label: the given order is kept.
    return word[3] ? `${word[3]}-${m}${d}` : `?-${m}${d}`;
  }
  return null;
}

/** Sortable value of a time label: year, year-month, year-quarter or date. */
export function timeKey(t: string): number {
  const norm = timeLabel(t) ?? t.trim();
  if (norm.startsWith("?-")) return Number.MAX_SAFE_INTEGER;
  const q = /^(\d{4})-?Q([1-4])$/i.exec(norm);
  if (q) return Date.UTC(Number(q[1]), (Number(q[2]) - 1) * 3, 1);
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(norm);
  if (m) return Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1);
  const d = Date.parse(t);
  return Number.isNaN(d) ? Number.MAX_SAFE_INTEGER : d;
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
