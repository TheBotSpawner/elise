import type {
  FieldMapping,
  RecordValue,
  StructuredRecord,
  StructuredSource,
} from "../capabilities/structured";
import type { BuiltVisualization, VizLocale } from "../workspace/visualization";

/**
 * Analysis of a structured database (ADR-048): "¿cómo está la pipeline?" over the live records.
 * Everything here is deterministic and comes only from the source's own schema and values —
 * which property is the stage, the value, the close date is read from the live schema (never a
 * hardcoded database), and a metric the data can't support is simply absent.
 */

export const ANALYSIS_LIMITS = {
  /** Records read per analysis: 10 pages of 100 (bounded; larger sources are reported partial). */
  maxRecords: 1000,
  pageSize: 100,
  /** An open record not edited for this long is stale. */
  staleDays: 30,
  /** "Closing soon" horizon. */
  soonDays: 30,
  attention: 8,
} as const;

const key = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const WON = /(ganad|won|firmad|vendid|cerrad[oa]\s*(-|–)?\s*ganad|closed\s*won|aceptad|exito)/;
const LOST =
  /(perdid|lost|descartad|cancelad|rechazad|closed\s*lost|no\s*avanz|desestimad|abandonad)/;

const DORMANT = /(dormid|dormant|follow.?up futuro|pausad|on hold|en espera|congelad)/;

/** Won, lost, or parked for later (dormant); null is open/active. */
export type Outcome = "won" | "lost" | "dormant" | null;

/** Won/lost from the stage's own option: its status group, then its name. Unknown → open. */
export function stageOutcome(name: string | null, field: FieldMapping | null): Outcome {
  if (!name) return null;
  const k = key(name);
  if (LOST.test(k)) return "lost";
  if (WON.test(k)) return "won";
  if (DORMANT.test(k)) return "dormant";
  const group = field?.options?.find((o) => o.name === name)?.group;
  return group === "complete" ? "won" : null;
}

export interface AnalysisFields {
  stage: FieldMapping | null;
  value: FieldMapping | null;
  close: FieldMapping | null;
  company: FieldMapping | null;
}

const pick = (fields: FieldMapping[], ok: (f: FieldMapping) => boolean, names: RegExp[]) => {
  const usable = fields.filter((f) => !f.broken && ok(f));
  for (const re of names) {
    const hit = usable.find((f) => re.test(key(f.propertyName)) || re.test(f.key));
    if (hit) return hit;
  }
  return null;
};

/** Which live properties mean stage, value, close date and company (by type, then name). */
export function analysisFields(source: StructuredSource): AnalysisFields {
  const f = source.fields;
  return {
    stage:
      pick(f, (x) => x.type === "status", [/./]) ??
      pick(f, (x) => x.type === "select", [
        /^(etapa|stage|estado|status|fase|phase)$/,
        /(etapa|stage|estado|status|fase)/,
      ]),
    value:
      pick(f, (x) => x.type === "number" || x.type === "computed", [
        /(valor|value|monto|amount|importe|precio|revenue|ingreso|presupuesto|budget|deal)/,
      ]) ??
      (f.filter((x) => x.type === "number" && !x.broken).length === 1
        ? f.find((x) => x.type === "number" && !x.broken)!
        : null),
    close: pick(f, (x) => x.type === "date", [
      /(cierre|close|closing)/,
      /(vence|vencimiento|due|deadline|estimad|expected|limite|entrega)/,
    ]),
    company: pick(f, (x) => x.type === "select" || x.type === "multi_select" || x.type === "text", [
      /(empresa|company|cliente|client|account|cuenta|organizaci)/,
    ]),
  };
}

export interface AttentionItem {
  id: string;
  title: string;
  url: string | null;
  stage: string | null;
  value: number | null;
  close: string | null;
  updatedAt: string | null;
  reason: "overdue" | "closing_soon" | "stale" | "missing_info" | "high_value";
}

export interface StructuredAnalysis {
  source: { id: string; name: string; url: string | null };
  /** The properties the numbers come from (their names in the source). */
  fields: {
    stage: string | null;
    value: string | null;
    close: string | null;
    company: string | null;
  };
  /** Records analyzed; `complete` is false when the source has more than the bound. */
  records: number;
  complete: boolean;
  scope: "all" | "open";
  total: number;
  open: number;
  won: number;
  lost: number;
  dormant: number;
  byStage: { stage: string; count: number; value: number | null; outcome: Outcome }[];
  value: { open: number; won: number; total: number } | null;
  overdue: number;
  closingSoon: number;
  stale: number;
  missingInfo: number;
  byCompany: { name: string; count: number }[];
  attention: AttentionItem[];
  rank: "attention" | "value" | "close";
  today: string;
}

const str = (v: RecordValue | undefined): string | null =>
  typeof v === "string" && v.trim() ? v : Array.isArray(v) && v.length ? v.join(", ") : null;
const numOf = (v: RecordValue | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const dateOf = (v: RecordValue | undefined): string | null =>
  v && typeof v === "object" && !Array.isArray(v) && "start" in v
    ? v.start.slice(0, 10)
    : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)
      ? v.slice(0, 10)
      : null;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function analyzeRecords(
  source: StructuredSource,
  records: readonly StructuredRecord[],
  opts: {
    today: string;
    complete: boolean;
    scope?: "all" | "open";
    rank?: StructuredAnalysis["rank"];
  },
): StructuredAnalysis {
  const fields = analysisFields(source);
  const rows = records.map((r) => {
    const stage = fields.stage ? str(r.values[fields.stage.key]) : null;
    return {
      r,
      stage,
      outcome: stageOutcome(stage, fields.stage),
      value: fields.value ? numOf(r.values[fields.value.key]) : null,
      close: fields.close ? dateOf(r.values[fields.close.key]) : null,
      company: fields.company ? str(r.values[fields.company.key]) : null,
    };
  });
  const scope = opts.scope ?? "all";
  const inScope = scope === "open" ? rows.filter((x) => !x.outcome) : rows;
  const open = inScope.filter((x) => !x.outcome);
  const sum = (xs: typeof rows) => xs.reduce((n, x) => n + (x.value ?? 0), 0);

  // Stages in the schema's own order; values the schema doesn't list come after.
  const order = fields.stage?.options?.map((o) => o.name) ?? [];
  const counts = new Map<string, typeof rows>();
  for (const x of inScope) {
    const k = x.stage ?? "—";
    counts.set(k, [...(counts.get(k) ?? []), x]);
  }
  const byStage = [...counts.entries()]
    .sort(
      ([a], [b]) =>
        (order.indexOf(a) === -1 ? 999 : order.indexOf(a)) -
          (order.indexOf(b) === -1 ? 999 : order.indexOf(b)) || a.localeCompare(b),
    )
    .map(([stage, xs]) => ({
      stage,
      count: xs.length,
      value: fields.value ? sum(xs) : null,
      outcome: stage === "—" ? null : stageOutcome(stage, fields.stage),
    }));

  const today = opts.today;
  const soon = addDays(today, ANALYSIS_LIMITS.soonDays);
  const staleBefore = addDays(today, -ANALYSIS_LIMITS.staleDays);
  const item = (x: (typeof rows)[number], reason: AttentionItem["reason"]): AttentionItem => ({
    id: x.r.id,
    title: x.r.title,
    url: x.r.url,
    stage: x.stage,
    value: x.value,
    close: x.close,
    updatedAt: x.r.updatedAt,
    reason,
  });
  const overdue = open.filter((x) => x.close && x.close < today);
  const closingSoon = open
    .filter((x) => x.close && x.close >= today && x.close <= soon)
    .sort((a, b) => a.close!.localeCompare(b.close!));
  const stale = open.filter((x) => x.r.updatedAt && x.r.updatedAt.slice(0, 10) < staleBefore);
  const missing = open.filter(
    (x) =>
      (fields.stage && !x.stage) ||
      (fields.value && x.value === null) ||
      (fields.close && !x.close),
  );
  const highValue = fields.value
    ? [...open]
        .filter((x) => x.value !== null)
        .sort((a, b) => b.value! - a.value!)
        .slice(0, 3)
    : [];

  const rank = opts.rank ?? "attention";
  let attention: AttentionItem[];
  if (rank === "value")
    attention = [...open]
      .filter((x) => x.value !== null)
      .sort((a, b) => b.value! - a.value!)
      .map((x) => item(x, "high_value"));
  else if (rank === "close")
    attention = [...open]
      .filter((x) => x.close)
      .sort((a, b) => a.close!.localeCompare(b.close!))
      .map((x) => item(x, x.close! < today ? "overdue" : "closing_soon"));
  else {
    const seen = new Set<string>();
    attention = [
      ...overdue.map((x) => item(x, "overdue")),
      ...closingSoon.map((x) => item(x, "closing_soon")),
      ...stale.map((x) => item(x, "stale")),
      ...highValue.map((x) => item(x, "high_value")),
      ...missing.map((x) => item(x, "missing_info")),
    ].filter((a) => !seen.has(a.id) && Boolean(seen.add(a.id)));
  }

  const companies = new Map<string, number>();
  for (const x of open)
    if (x.company) companies.set(x.company, (companies.get(x.company) ?? 0) + 1);

  return {
    source: { id: source.id, name: source.name, url: source.url },
    fields: {
      stage: fields.stage?.propertyName ?? null,
      value: fields.value?.propertyName ?? null,
      close: fields.close?.propertyName ?? null,
      company: fields.company?.propertyName ?? null,
    },
    records: records.length,
    complete: opts.complete,
    scope,
    total: inScope.length,
    open: open.length,
    won: inScope.filter((x) => x.outcome === "won").length,
    lost: inScope.filter((x) => x.outcome === "lost").length,
    dormant: inScope.filter((x) => x.outcome === "dormant").length,
    byStage,
    value: fields.value
      ? {
          open: sum(open),
          won: sum(inScope.filter((x) => x.outcome === "won")),
          total: sum(inScope),
        }
      : null,
    overdue: overdue.length,
    closingSoon: closingSoon.length,
    stale: stale.length,
    missingInfo: missing.length,
    byCompany: [...companies.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
    attention: attention.slice(0, ANALYSIS_LIMITS.attention),
    rank,
    today,
  };
}

// ── Presentation (≤ 3 Surfaces, ADR-048) ─────────────────────────────────────

const TEXT = {
  es: {
    open: "Abiertas",
    pipeline: (name: string) => `${name}: pipeline abierta`,
    openCount: (name: string) => `${name}: abiertas`,
    won: "Ganadas",
    lost: "Perdidas",
    total: "Total",
    byStage: "Por etapa",
    attention: "Para mirar",
    byValue: "Por valor",
    byClose: "Próximos cierres",
    columns: ["Nombre", "Etapa", "Cierre", "Valor", "Motivo"],
    reasons: {
      overdue: "Cierre vencido",
      closing_soon: "Cierra pronto",
      stale: "Sin cambios hace 30+ días",
      missing_info: "Faltan datos",
      high_value: "Alto valor",
    },
    partial: (n: number) => `Basado en los primeros ${n} registros`,
  },
  en: {
    open: "Open",
    pipeline: (name: string) => `${name}: open pipeline`,
    openCount: (name: string) => `${name}: open`,
    won: "Won",
    lost: "Lost",
    total: "Total",
    byStage: "By stage",
    attention: "Needs a look",
    byValue: "By value",
    byClose: "Next to close",
    columns: ["Name", "Stage", "Close", "Value", "Why"],
    reasons: {
      overdue: "Close date passed",
      closing_soon: "Closing soon",
      stale: "No changes in 30+ days",
      missing_info: "Missing details",
      high_value: "High value",
    },
    partial: (n: number) => `Based on the first ${n} records`,
  },
} as const;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * At most three visuals, one analytical object: the headline (KPI), the stage distribution
 * (only when there are stages), and what needs a look (only when something does). Roles are
 * stable, so a follow-up ("solo las activas") replaces them instead of adding cards.
 */
export function analysisVisuals(
  a: StructuredAnalysis,
  locale: VizLocale = "es",
): BuiltVisualization[] {
  const t = TEXT[locale] ?? TEXT.es;
  const source = a.source.name;
  const note = a.complete ? undefined : t.partial(a.records);
  const out: BuiltVisualization[] = [];
  out.push({
    role: "summary",
    spec: {
      type: "kpi",
      title: clip(a.value ? t.pipeline(source) : t.openCount(source), 120),
      format: { kind: "number" },
      value: a.value ? Math.round(a.value.open) : a.open,
      goodWhen: "none",
      secondary: [
        ...(a.value ? [{ label: t.open, value: a.open }] : []),
        { label: t.won, value: a.won },
        { label: t.lost, value: a.lost },
      ].slice(0, 3),
      ...(a.value && a.fields.value ? { subtitle: clip(a.fields.value, 120) } : {}),
      ...(note ? { note } : {}),
      source: "Notion",
      confidence: a.complete ? "confirmed" : "likely",
    },
  });
  const stages = a.byStage.filter((s) => s.stage !== "—" || a.byStage.length > 1);
  if (a.fields.stage && stages.length >= 2)
    out.push({
      role: "stages",
      spec: {
        type: "hbar",
        title: `${t.byStage} · ${clip(a.fields.stage, 40)}`,
        format: { kind: "count" },
        rows: stages.slice(0, 12).map((s) => ({ label: clip(s.stage, 60), value: s.count })),
        source: "Notion",
      },
    });
  if (a.attention.length)
    out.push({
      role: "attention",
      spec: {
        type: "table",
        title: a.rank === "value" ? t.byValue : a.rank === "close" ? t.byClose : t.attention,
        format: { kind: "number" },
        columns: [
          { label: t.columns[0] },
          { label: t.columns[1] },
          ...(a.fields.close ? [{ label: t.columns[2] }] : []),
          ...(a.fields.value ? [{ label: t.columns[3], numeric: true }] : []),
          { label: t.columns[4] },
        ],
        rows: a.attention
          .slice(0, 8)
          .map((x) => [
            clip(x.title, 80),
            clip(x.stage ?? "—", 80),
            ...(a.fields.close ? [x.close ?? "—"] : []),
            ...(a.fields.value ? [x.value === null ? "—" : String(Math.round(x.value))] : []),
            t.reasons[x.reason],
          ]),
        source: "Notion",
      },
    });
  return out;
}
