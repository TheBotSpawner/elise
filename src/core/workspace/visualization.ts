import { z } from "zod";

import type {
  CurrencyTotals,
  FinanceBreakdown,
  FinanceSourceInfo,
  FinanceSummary,
} from "../capabilities/finance";
import type { HabitProgress } from "../capabilities/habits";

/**
 * Visualization specs (ADR-021): typed, validated chart templates. ELISE may choose a template
 * and its numbers; it never supplies markup, styles, SVG or code. The UI owns every pixel.
 * Builders below derive specs from real structured results only — no invented metrics.
 */

const label = z.string().trim().min(1).max(60);
const value = z.number().finite();
const values = z.array(value.nullable()).min(1).max(62);

export const CONFIDENCE = ["confirmed", "likely", "uncertain", "conflict", "missing"] as const;

const format = z
  .object({
    kind: z.enum(["number", "currency", "percent", "hours", "count"]),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    decimals: z.number().int().min(0).max(2).optional(),
  })
  .strict();

/** Where a number comes from: a page or document ELISE actually read (ADR-027). */
const sourceItem = z
  .object({
    title: z.string().trim().min(1).max(120),
    url: z
      .string()
      .max(2000)
      .refine((u) => /^https:\/\//.test(u) || u.startsWith("/"), "https or internal links only")
      .nullable(),
  })
  .strict();

/** Index into the chart's `sources` (provenance of one datapoint). */
const sourceRef = z.number().int().min(0).max(11);

/** A typed reference value (current level, budget, goal…), never a decorative line. */
const reference = z.object({ value, label, source: sourceRef.optional() }).strict();

/** A few evidence-backed notes pinned to a category or time label ("Current level"). */
const annotations = z
  .array(z.object({ at: label, text: z.string().trim().min(1).max(40) }).strict())
  .max(3);

const base = {
  title: z.string().trim().min(1).max(120),
  /** Secondary line: metric, unit, horizon ("Year-end 2026 targets · index points"). */
  subtitle: z.string().trim().max(120).optional(),
  /** The pages/documents the numbers come from; datapoints point into this list. */
  sources: z.array(sourceItem).max(12).optional(),
  /** One sentence that says what the chart answers ("Below August's pace from the 15th"). */
  insight: z.string().trim().max(240).optional(),
  format: format.default({ kind: "number" }),
  /** Where the numbers come from ("Bank sync · 2 accounts"). */
  source: z.string().trim().max(160).optional(),
  confidence: z.enum(CONFIDENCE).optional(),
};

const target = z.object({ value, label: label.optional() }).strict();

const series = z.object({ name: label, values }).strict();

export const VISUALIZATION_TYPES = [
  "kpi",
  "line",
  "area",
  "bar",
  "hbar",
  "diverging",
  "distribution",
  "progress",
  "streak",
  "table",
  "dot",
  "range",
] as const;
export type VisualizationType = (typeof VISUALIZATION_TYPES)[number];

const DAY_STATES = ["done", "miss", "rest", "today", "future"] as const;

export const visualizationSpec = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("kpi"),
        ...base,
        value,
        previous: value.nullable().optional(),
        /** What the previous value was ("August"). */
        previousLabel: label.optional(),
        /** Which direction is good news: spending going down is. */
        goodWhen: z.enum(["up", "down", "none"]).default("none"),
        note: z.string().trim().max(160).optional(),
        /** A few related figures in the same format ("Income", "Net"). */
        secondary: z.array(z.object({ label, value }).strict()).max(3).optional(),
        spark: z.array(value).min(2).max(24).optional(),
        /** Progress toward a goal, 0–100, with the expected pace by now. */
        goal: z
          .object({
            percent: z.number().min(0).max(100),
            pace: z.number().min(0).max(100).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        type: z.enum(["line", "area"]),
        ...base,
        x: z.array(label).min(2).max(62),
        series: z.array(series).min(1).max(3),
        target: target.optional(),
        reference: reference.optional(),
        annotations: annotations.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("bar"),
        ...base,
        x: z.array(label).min(1).max(24),
        /** One series, or two paired periods (current first). */
        series: z.array(series).min(1).max(2),
        highlight: z.array(z.number().int().min(0)).max(24).optional(),
        target: target.optional(),
        reference: reference.optional(),
        annotations: annotations.optional(),
      })
      .strict(),
    z
      .object({
        type: z.enum(["hbar", "distribution"]),
        ...base,
        rows: z
          .array(z.object({ label, value: value.min(0) }).strict())
          .min(1)
          .max(12),
        highlight: z.array(label).max(12).optional(),
      })
      .strict(),
    z
      .object({
        /**
         * Values of the same metric compared across categories (analysts, companies…), as dots
         * on one scale — better than bars when values are close. Optional reference with
         * deltas computed by ELISE, not the model.
         */
        type: z.literal("dot"),
        ...base,
        rows: z
          .array(
            z
              .object({
                label,
                value,
                /** Versus the reference, computed deterministically. */
                delta: value.optional(),
                deltaPct: value.optional(),
                source: sourceRef.optional(),
                /** Weakly evidenced: shown hollow and said so. */
                uncertain: z.boolean().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(12),
        reference: reference.optional(),
        annotations: annotations.optional(),
      })
      .strict(),
    z
      .object({
        /**
         * Scenarios or an estimate range (bear/base/bull, low/consensus/high) on one scale. A
         * range is not a probability distribution unless the source says so.
         */
        type: z.literal("range"),
        ...base,
        scenarios: z
          .array(
            z
              .object({
                label,
                value,
                kind: z.enum(["low", "base", "high", "scenario"]).default("scenario"),
                source: sourceRef.optional(),
              })
              .strict(),
          )
          .min(2)
          .max(8),
        reference: reference.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("diverging"),
        ...base,
        rows: z.array(z.object({ label, value }).strict()).min(1).max(12),
        highlight: z.array(label).max(12).optional(),
        negativeLabel: label,
        positiveLabel: label,
      })
      .strict(),
    z
      .object({
        type: z.literal("progress"),
        ...base,
        rows: z
          .array(
            z
              .object({
                label,
                /** 0–1. */
                value: z.number().min(0).max(1),
                /** Where it should be by now, 0–1. */
                pace: z.number().min(0).max(1).optional(),
                state: z.string().trim().max(60).optional(),
                flag: z.boolean().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(10),
      })
      .strict(),
    z
      .object({
        type: z.literal("streak"),
        ...base,
        days: z.array(z.string().trim().min(1).max(3)).length(7),
        today: z.number().int().min(0).max(6).optional(),
        rows: z
          .array(
            z
              .object({
                label,
                meta: z.string().trim().max(80).optional(),
                days: z.array(z.enum(DAY_STATES)).length(7),
                summary: z.string().trim().max(40),
                state: z.string().trim().max(40).optional(),
                behind: z.boolean().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(8),
      })
      .strict(),
    z
      .object({
        type: z.literal("table"),
        ...base,
        columns: z
          .array(z.object({ label: z.string().trim().max(40), numeric: z.boolean().optional() }))
          .min(1)
          .max(6),
        rows: z
          .array(z.array(z.string().trim().max(80)).min(1).max(6))
          .min(1)
          .max(12),
        highlightRow: z.number().int().min(0).max(11).optional(),
        note: z.string().trim().max(120).optional(),
      })
      .strict(),
  ])
  .superRefine((spec, ctx) => {
    // Every series has one value per x label; tables are rectangular.
    if ((spec.type === "line" || spec.type === "area" || spec.type === "bar") && spec.series)
      for (const s of spec.series)
        if (s.values.length !== spec.x.length)
          ctx.addIssue({
            code: "custom",
            message: `Series "${s.name}" needs ${spec.x.length} values`,
          });
    if (spec.type === "table")
      for (const r of spec.rows)
        if (r.length !== spec.columns.length)
          ctx.addIssue({ code: "custom", message: "Every row needs one cell per column" });
    // A datapoint's source must exist in the chart's source list.
    const n = spec.sources?.length ?? 0;
    const refs: (number | undefined)[] = [];
    if (spec.type === "dot") refs.push(...spec.rows.map((r) => r.source));
    if (spec.type === "range") refs.push(...spec.scenarios.map((r) => r.source));
    if ("reference" in spec && spec.reference) refs.push(spec.reference.source);
    if (refs.some((r) => r !== undefined && r >= n))
      ctx.addIssue({ code: "custom", message: "A datapoint points to a missing source" });
    if (spec.format.kind === "currency" && !spec.format.currency)
      ctx.addIssue({ code: "custom", message: "A currency chart needs a currency code" });
  });

export type VisualizationSpec = z.infer<typeof visualizationSpec>;

// ── Builders from real results ───────────────────────────────────────────────

export type VizLocale = "es" | "en";

/** The few words derived charts need, in the user's language. */
const TEXT = {
  en: {
    spent: "Spent",
    income: "Income",
    net: "Net",
    previous: "Previous period",
    byCategory: "Where it went",
    change: "Change vs previous period",
    less: "Less",
    more: "More",
    largest: "Largest expenses",
    columns: ["Date", "Description", "Amount"] as [string, string, string],
    otherCurrencies: "Other currencies are not included in this chart.",
    habits: "Habits this week",
    days: ["M", "T", "W", "T", "F", "S", "S"],
    behind: "Behind",
    onTrack: "On track",
    streak: (n: number, unit: "days" | "weeks") => `${n} ${unit} in a row`,
    goals: "Goals",
    spending: "Spending",
    by: (g: string) => `Spending by ${g.replace("_", " ")}`,
  },
  es: {
    spent: "Gastado",
    income: "Ingresos",
    net: "Neto",
    previous: "Período anterior",
    byCategory: "En qué se fue",
    change: "Cambio vs. período anterior",
    less: "Menos",
    more: "Más",
    largest: "Mayores gastos",
    columns: ["Fecha", "Descripción", "Monto"] as [string, string, string],
    otherCurrencies: "Otras monedas no se incluyen en este gráfico.",
    habits: "Hábitos de esta semana",
    days: ["L", "M", "M", "J", "V", "S", "D"],
    behind: "Atrasado",
    onTrack: "Al día",
    streak: (n: number, unit: "days" | "weeks") =>
      `${n} ${unit === "days" ? "días" : "semanas"} seguidos`,
    goals: "Objetivos",
    spending: "Gastos",
    by: (g: string) =>
      `Gastos por ${({ month: "mes", week: "semana", day: "día", category: "categoría", account: "cuenta", counterparty: "comercio", project: "proyecto", payment_method: "medio de pago", source: "fuente", type: "tipo", currency: "moneda" } as Record<string, string>)[g] ?? g}`,
  },
} as const;
export const vizText = (locale: VizLocale = "en") => TEXT[locale];

/** Decimal strings (finance amounts) → numbers for drawing only; the stored amounts stay exact. */
const num = (amount: string) => {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.abs(n) : 0;
};
const round = (n: number) => Math.round(n * 100) / 100;

/** The currency most of the spending is in: charts never add different currencies. */
function mainCurrency(totals: CurrencyTotals[]): string | null {
  const best = [...totals].sort((a, b) => b.expenseCount - a.expenseCount)[0];
  return best?.currency ?? null;
}

/** Which sources the numbers come from ("ELISE · Budget sheet"). */
const sourceLine = (sources: FinanceSourceInfo[]) =>
  sources
    .filter((x) => x.included)
    .map((x) => x.name)
    .slice(0, 3)
    .join(" · ");

export interface BuiltVisualization {
  /** Stable role within its result ("kpi", "categories"): the Surface id derives from it. */
  role: string;
  spec: VisualizationSpec;
}

/**
 * "How much did I spend this month compared with last month?": the headline number with its
 * change, where it went, and what moved — only from the summary's own numbers.
 */
export function financeSummaryVisuals(
  s: FinanceSummary,
  locale: VizLocale = "en",
): BuiltVisualization[] {
  const labels = vizText(locale);
  const currency = mainCurrency(s.current.totals);
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return [];
  const fmt = { kind: "currency" as const, currency };
  const cur = s.current.totals.find((t) => t.currency === currency)!;
  const prev = s.previous?.totals.find((t) => t.currency === currency) ?? null;
  const source = sourceLine(s.sources);
  const out: BuiltVisualization[] = [];
  const spent = round(num(cur.expense));
  out.push({
    role: "kpi",
    spec: {
      type: "kpi",
      title: labels.spent,
      format: fmt,
      value: spent,
      ...(prev ? { previous: round(num(prev.expense)), previousLabel: labels.previous } : {}),
      goodWhen: "down",
      ...(cur.incomeCount
        ? {
            secondary: [
              { label: labels.income, value: round(num(cur.income)) },
              { label: labels.net, value: round(Number(cur.net) || 0) },
            ],
          }
        : {}),
      ...(s.current.totals.length > 1 ? { note: labels.otherCurrencies } : {}),
      ...(source ? { source } : {}),
      confidence: "confirmed",
    },
  });
  const expenses = s.current.byCategory
    .filter((g) => g.type === "expense" && g.currency === currency && num(g.total) > 0)
    .sort((a, b) => num(b.total) - num(a.total));
  if (expenses.length >= 2) {
    // At most 7 slices: the rest is grouped, never dropped.
    const top = expenses.slice(0, 6);
    const rest = expenses.slice(6).reduce((n, g) => n + num(g.total), 0);
    out.push({
      role: "categories",
      spec: {
        type: "distribution",
        title: labels.byCategory,
        format: fmt,
        rows: [
          ...top.map((g) => ({ label: g.key.slice(0, 60) || "—", value: round(num(g.total)) })),
          ...(rest > 0 ? [{ label: "…", value: round(rest) }] : []),
        ],
        ...(source ? { source } : {}),
      },
    });
  }
  if (s.previous) {
    const before = new Map(
      s.previous.byCategory
        .filter((g) => g.type === "expense" && g.currency === currency)
        .map((g) => [g.key, num(g.total)]),
    );
    const keys = new Set([...expenses.map((g) => g.key), ...before.keys()]);
    const rows = [...keys]
      .map((key) => {
        const now = num(expenses.find((g) => g.key === key)?.total ?? "0");
        return { label: key.slice(0, 60) || "—", value: round(now - (before.get(key) ?? 0)) };
      })
      .filter((r) => r.value !== 0)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 8);
    if (rows.length >= 2)
      out.push({
        role: "change",
        spec: {
          type: "diverging",
          title: labels.change,
          format: fmt,
          rows,
          highlight: [rows[0]!.label],
          negativeLabel: labels.less,
          positiveLabel: labels.more,
          ...(source ? { source } : {}),
        },
      });
  }
  const largest = s.current.largest.filter((t) => t.currency === currency && t.type === "expense");
  if (largest.length)
    out.push({
      role: "largest",
      spec: {
        type: "table",
        title: labels.largest,
        format: fmt,
        columns: [
          { label: labels.columns[0] },
          { label: labels.columns[1] },
          { label: labels.columns[2], numeric: true },
        ],
        rows: largest
          .slice(0, 6)
          .map((t) => [t.date.slice(5, 10), t.label.slice(0, 80), String(round(num(t.amount)))]),
      },
    });
  return out;
}

/** A breakdown over time becomes bars (a line for days); by category or payee, ranked bars. */
export function financeBreakdownVisual(
  b: FinanceBreakdown,
  locale: VizLocale = "en",
): BuiltVisualization | null {
  const title = b.groupBy ? vizText(locale).by(b.groupBy) : vizText(locale).spending;
  const currency = mainCurrency(b.totals);
  if (!currency || !b.groupBy || !/^[A-Z]{3}$/.test(currency)) return null;
  const fmt = { kind: "currency" as const, currency };
  const groups = b.groups.filter((g) => g.currency === currency && g.type === "expense");
  if (groups.length < 2) return null;
  const temporal = b.groupBy === "month" || b.groupBy === "week" || b.groupBy === "day";
  if (temporal) {
    const sorted = [...groups].sort((a, c) => a.key.localeCompare(c.key)).slice(-31);
    const x = sorted.map((g) => (b.groupBy === "month" ? g.key : g.key.slice(5)));
    const vals = sorted.map((g) => round(num(g.total)));
    const peak = vals.indexOf(Math.max(...vals));
    if (b.groupBy === "day" && sorted.length >= 8)
      return {
        role: "breakdown",
        spec: { type: "area", title, format: fmt, x, series: [{ name: title, values: vals }] },
      };
    return {
      role: "breakdown",
      spec: {
        type: "bar",
        title,
        format: fmt,
        x: x.slice(0, 24),
        series: [{ name: title, values: vals.slice(0, 24) }],
        ...(peak >= 0 && peak < 24 ? { highlight: [peak] } : {}),
      },
    };
  }
  const rows = [...groups]
    .sort((a, c) => num(c.total) - num(a.total))
    .slice(0, 10)
    .map((g) => ({ label: g.key.slice(0, 60) || "—", value: round(num(g.total)) }));
  return {
    role: "breakdown",
    spec: { type: "hbar", title, format: fmt, rows, highlight: [rows[0]!.label] },
  };
}

/** This week, one row per habit: done, missed, rest days, today and what is still ahead. */
export function habitsVisual(
  habits: HabitProgress[],
  locale: VizLocale = "en",
): BuiltVisualization | null {
  const labels = vizText(locale);
  const rows = habits
    .filter((h) => h.week.days.length === 7)
    .slice(0, 8)
    .map((h) => ({
      label: h.name.slice(0, 60) || "—",
      days: h.week.days.map((d) =>
        d.date === h.today.date
          ? ("today" as const)
          : d.future
            ? ("future" as const)
            : !d.scheduled || d.skipped
              ? ("rest" as const)
              : d.met
                ? ("done" as const)
                : ("miss" as const),
      ),
      summary: `${h.week.done} / ${h.week.goal}`,
      state: h.week.atRisk
        ? labels.behind
        : h.streak.count > 1
          ? labels.streak(h.streak.count, h.streak.unit)
          : labels.onTrack,
      ...(h.week.atRisk ? { behind: true } : {}),
    }));
  if (!rows.length) return null;
  const todayIdx = habits[0]!.week.days.findIndex((d) => d.date === habits[0]!.today.date);
  return {
    role: "habits",
    spec: {
      type: "streak",
      title: labels.habits,
      format: { kind: "count" },
      days: [...labels.days],
      ...(todayIdx >= 0 ? { today: todayIdx } : {}),
      rows,
    },
  };
}

export interface GoalLike {
  title: string;
  percent: number | null;
  /** 0–100 expected by today (from start and target dates), when both exist. */
  pace: number | null;
}

/** Where a goal would be today on a straight line from its creation to its target date. */
export function goalPace(
  createdAt: string,
  targetDate: string | null,
  today: string,
): number | null {
  if (!targetDate) return null;
  const start = Date.parse(createdAt.slice(0, 10));
  const end = Date.parse(targetDate);
  const now = Date.parse(today);
  if (!(end > start) || Number.isNaN(now)) return null;
  return Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100));
}

/** Goals with measurable progress; a goal without a number is never given one. */
export function goalsVisual(
  goals: GoalLike[],
  locale: VizLocale = "en",
): BuiltVisualization | null {
  const title = vizText(locale).goals;
  const rows = goals
    .filter((g) => g.percent !== null)
    .slice(0, 10)
    .map((g) => ({
      label: g.title.slice(0, 60) || "—",
      value: g.percent! / 100,
      state: `${Math.round(g.percent!)}%`,
      ...(g.pace !== null ? { pace: Math.min(1, Math.max(0, g.pace / 100)) } : {}),
      ...(g.pace !== null && g.percent! < g.pace ? { flag: true } : {}),
    }));
  if (!rows.length) return null;
  return { role: "goals", spec: { type: "progress", title, format: { kind: "percent" }, rows } };
}
