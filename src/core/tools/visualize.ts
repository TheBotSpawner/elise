import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { AppError } from "../errors";
import { toLocalDateTime } from "../time";
import { surfaceId, type Surface, type WorkspaceState } from "../workspace/model";
import { draftDefaults, PAYLOADS, type SurfacePayloads } from "../workspace/registry";
import {
  planTemporal,
  type ResolvedSource,
  type TemporalEventInput,
} from "../workspace/temporal-planner";
import { TEMPORAL_KINDS, TEMPORAL_VIEWS, type VisualizationSpec } from "../workspace/visualization";
import { planVisualization, type KnownSources } from "../workspace/viz-planner";

/**
 * ui.visualize (ADR-027): the model hands over the evidence — sourced observations and what it
 * wants to show — and the Visualization Planner picks the chart, checks provenance and
 * comparability, and computes deltas and ranges. Called in the same response as the answer, it
 * costs no extra model call; called again with the same metric and horizon, it updates the
 * same chart (sort, exclude, add a reference, change the representation).
 */

const observation = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .describe('What the value belongs to: "J.P. Morgan", "2024", "Groceries".'),
    value: z.number().finite(),
    time: z
      .string()
      .trim()
      .max(20)
      .optional()
      .describe('Only for points in time: "2024", "2025-03", "2025-Q4", "2025-10-02".'),
    series: z
      .string()
      .trim()
      .max(60)
      .optional()
      .describe("Which series, when several are compared over time."),
    unit: z.string().trim().max(30).optional(),
    horizon: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe('What the value refers to: "2026 year-end", "next 12 months".'),
    kind: z
      .enum([
        "actual",
        "estimate",
        "target",
        "low",
        "base",
        "high",
        "scenario",
        "share",
        "start",
        "delta",
        "end",
      ])
      .optional()
      .describe("start/delta/end for contributions to a change (a waterfall)."),
    x: z
      .number()
      .finite()
      .optional()
      .describe("Only for a relationship: the other variable (value is the y)."),
    open: z.number().finite().optional().describe("Only with real OHLC data: value is the close."),
    high: z.number().finite().optional(),
    low: z.number().finite().optional(),
    source: z
      .string()
      .trim()
      .max(2000)
      .describe("The exact URL (from your sources) or Surface handle the number comes from."),
    confidence: z.enum(["confirmed", "reported", "inferred"]).optional(),
  })
  .strict();

const visualizeInput = z
  .object({
    intent: z
      .enum([
        "auto",
        "compare",
        "trend",
        "distribution",
        "range",
        "progress",
        "relationship",
        "frequency",
        "contribution",
      ])
      .default("auto")
      .describe(
        "What the chart should show: distribution = parts of a whole; relationship = two variables; frequency = how raw values are spread; contribution = what added up to a change. ELISE picks the chart from the data.",
      ),
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().max(120).optional(),
    metric: z
      .object({
        name: z.string().trim().min(1).max(60),
        unit: z.string().trim().max(30).optional(),
        format: z.enum(["number", "currency", "percent", "count", "hours"]).default("number"),
        currency: z.string().trim().length(3).optional(),
      })
      .strict(),
    horizon: z.string().trim().max(40).optional(),
    xMetric: z
      .object({
        name: z.string().trim().min(1).max(60),
        format: z.enum(["number", "currency", "percent", "count", "hours"]).default("number"),
      })
      .strict()
      .optional()
      .describe("Only for a relationship: what x is."),
    observations: z.array(observation).min(1).max(200),
    reference: z
      .object({
        label: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .describe('"Current level", "Budget", "Last month".'),
        value: z.number().finite(),
        source: z.string().trim().max(2000),
        unit: z.string().trim().max(30).optional(),
      })
      .strict()
      .optional(),
    chart: z
      .enum([
        "auto",
        "bar",
        "hbar",
        "line",
        "area",
        "dot",
        "range",
        "table",
        "pie",
        "donut",
        "kpi",
        "scatter",
        "histogram",
        "waterfall",
        "candlestick",
      ])
      .default("auto")
      .describe(
        "Only when the user asked for a chart type; ELISE refuses a misleading one and says why.",
      ),
    sort: z.enum(["asc", "desc", "none"]).default("none"),
    exclude: z
      .array(z.string().trim().max(60))
      .max(12)
      .optional()
      .describe('Labels to leave out ("sacá UBS").'),
  })
  .strict();

/** Every source ELISE holds on screen: URLs with their titles, and Surface handles. */
export function knownSources(state: WorkspaceState): Map<string, string> {
  const known = new Map<string, string>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.url === "string" && /^https:\/\//.test(o.url)) {
      const title = [o.title, o.siteName, o.domain].find((t) => typeof t === "string" && t) as
        string | undefined;
      if (!known.has(o.url))
        known.set(o.url, title ?? new URL(o.url).hostname.replace(/^www\./, ""));
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  for (const s of state.surfaces) {
    known.set(s.handle, s.title || s.handle);
    walk(s.payload, 0);
  }
  return known;
}

function port(env: ToolRunEnv) {
  if (!env.ctx.workspace)
    throw new AppError("VALIDATION_ERROR", "There is no Live Workspace in this context", {
      recovery: "review",
    });
  return env.ctx.workspace;
}

export const visualizeTool: ToolDefinition = {
  name: "ui.visualize",
  capability: "workspace",
  operation: "visualize",
  description:
    "Show numbers as a chart on the Live Canvas when it answers better than prose: comparisons across categories (analyst targets, companies, spending categories), a value over time (a price history: one observation per date), scenarios/ranges, shares of a whole, two variables against each other, how values are spread, what added up to a change. One number (a current price) is a KPI: never make a chart from one value. Give the evidence (each number with its exact source URL or Surface handle, unit and horizon) and the intent; ELISE chooses the chart, checks the numbers are comparable, and computes deltas against a reference (e.g. the current level). Call it in the same response as your answer. To change an existing chart (sort, remove one, add the current value, another representation), call it again with the same metric and horizon.",
  input: visualizeInput,
  async describe() {
    return { summary: "Show a chart" };
  },
  async run(raw, env) {
    const q = visualizeInput.parse(raw);
    const w = port(env);
    const state = w.state();
    const known: KnownSources = knownSources(state);
    const plan = planVisualization(
      {
        intent: q.intent,
        title: q.title,
        ...(q.subtitle ? { subtitle: q.subtitle } : {}),
        metric: q.metric,
        ...(q.horizon ? { horizon: q.horizon } : {}),
        ...(q.xMetric ? { xMetric: q.xMetric } : {}),
        observations: q.observations,
        ...(q.reference ? { reference: q.reference } : {}),
        preference: { chart: q.chart, sort: q.sort, ...(q.exclude ? { exclude: q.exclude } : {}) },
        locale: env.ctx.locale,
      },
      known,
    );
    if (!plan.ok) throw new AppError("VALIDATION_ERROR", plan.reason, { recovery: "review" });
    const payload = PAYLOADS.visualization.parse({ spec: plan.spec });
    // One chart per metric and horizon in this intent: follow-ups update it in place.
    const key = `${state.intent?.id ?? "none"}:viz:${q.metric.name.toLowerCase()}:${(q.horizon ?? "").toLowerCase()}`;
    const defaults = draftDefaults("visualization", payload);
    w.apply([
      {
        op: "present",
        at: env.ctx.now.toISOString(),
        surface: {
          id: surfaceId("visualization", key),
          type: "visualization",
          title: q.title,
          state: "ready",
          source: {
            capability: "workspace",
            label:
              (plan.spec.sources ?? [])
                .map((s) => s.title)
                .join(" · ")
                .slice(0, 200) || null,
          },
          ref: null,
          payload,
          intentId: state.intent?.id ?? null,
          ...defaults,
          // It answers the question: a primary, large chart, not a peripheral one.
          size: "large",
          priority: 82,
        },
      },
    ]);
    return {
      output: {
        shown: plan.spec.type,
        shape: plan.shape,
        ...(plan.facts.length ? { facts: plan.facts } : {}),
        ...(plan.dropped.length ? { leftOut: plan.dropped } : {}),
        ...(plan.notice ? { notice: plan.notice } : {}),
        instructions:
          "The chart is on screen with exact values and sources. In your answer give the insight in a sentence (use the facts above; don't read every number). Mention anything left out if it matters" +
          (plan.notice ? ", and say the notice briefly." : "."),
      },
    };
  },
};

// ── ui.timeline (ADR-028) ────────────────────────────────────────────────────

const temporalWhen = z.string().trim().max(16);

const temporalEvent = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe('Distinct per event: "Primer parcial", not "Parcial".'),
    start: temporalWhen.describe(
      '"2026-03-25", "2026-03-25T09:30", or a whole month "2026-03". Take the year from the source.',
    ),
    end: temporalWhen
      .optional()
      .describe('Inclusive last day of a range ("22–23 Sep" → "2026-09-23") or the end time.'),
    kind: z.enum(TEMPORAL_KINDS).default("general"),
    importance: z
      .enum(["high", "normal", "low"])
      .optional()
      .describe(
        "high for what matters most to this question; omitted → exams and deadlines stand out.",
      ),
    detail: z.string().trim().max(160).optional(),
    recurrence: z
      .string()
      .trim()
      .max(60)
      .optional()
      .describe('"Todos los martes": never expand it into dates.'),
    source: z
      .string()
      .trim()
      .max(2000)
      .describe(
        'Where the date comes from: a Knowledge citation "[2]", a Surface handle ("S3") or the exact URL.',
      ),
    confidence: z.enum(["confirmed", "reported", "inferred"]).optional(),
  })
  .strict();

const timelineInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    subtitle: z.string().trim().max(120).optional(),
    events: z
      .array(temporalEvent)
      .max(60)
      .optional()
      .describe("Omit to re-arrange the schedule already on screen (another view or focus)."),
    view: z
      .enum(["auto", ...TEMPORAL_VIEWS])
      .default("auto")
      .describe(
        "Only when the user asked for one; ELISE picks timeline/calendar/agenda from the dates.",
      ),
    focus: z
      .object({
        kinds: z.array(z.enum(TEMPORAL_KINDS)).max(10).optional(),
        from: z.string().trim().max(10).optional().describe("YYYY-MM-DD"),
        to: z.string().trim().max(10).optional().describe("YYYY-MM-DD"),
      })
      .strict()
      .nullable()
      .optional()
      .describe(
        '"Solo los parciales" → kinds ["exam"]; "¿qué tengo en septiembre?" → from/to. null clears it.',
      ),
  })
  .strict();

type TemporalSpec = Extract<VisualizationSpec, { type: "temporal" }>;

/** The user asked to see dates: even two are worth showing then. */
const ASKED_FOR_DATES =
  /\b(cronogramas?|calendarios?|agenda|timeline|l[ií]nea de tiempo|fechas|schedules?|calendars?|dates|itinerar\w*)\b/i;

/**
 * A source the model names → what ELISE actually holds: a Knowledge citation [n] from the
 * latest search (with its passage), a document or other Surface by handle, or a URL on screen.
 */
export function resolveSource(
  state: WorkspaceState,
  known: KnownSources,
  raw: string,
): ResolvedSource | null {
  const s = raw.trim();
  const cited = /^\[?(\d{1,2})\]?$/.exec(s);
  if (cited) {
    const ref = Number(cited[1]);
    // ponytail: refs are per search; the newest Knowledge Surface wins when two searches overlap.
    const docs = state.surfaces
      .filter((x) => x.type === "knowledge_result" || x.type === "knowledge_source")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const sf of docs) {
      const list =
        sf.type === "knowledge_result"
          ? (sf.payload as SurfacePayloads["knowledge_result"]).sources
          : [sf.payload as SurfacePayloads["knowledge_source"]];
      for (const d of list)
        for (const p of d.passages)
          if (p.ref === ref)
            return {
              title: `${d.title}${p.page ? ` · p. ${p.page}` : ""}`,
              url: `/knowledge/items/${d.itemId}`,
              excerpt: p.excerpt,
            };
    }
    return null;
  }
  const surface = state.surfaces.find((x) => x.handle === s);
  if (surface && (surface.type === "knowledge_source" || surface.type === "document"))
    return {
      title: surface.title || s,
      url: `/knowledge/items/${(surface.payload as { itemId: string }).itemId}`,
    };
  const title = known.get(s);
  if (!title) return null;
  return { title, url: /^https:\/\//.test(s) ? s : null };
}

/** The schedule already on screen (the newest one), to re-arrange without re-sending dates. */
function currentTemporal(state: WorkspaceState): Surface<SurfacePayloads["visualization"]> | null {
  const found = state.surfaces
    .filter((s) => s.type === "visualization")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .find((s) => (s.payload as SurfacePayloads["visualization"]).spec.type === "temporal");
  return (found as Surface<SurfacePayloads["visualization"]> | undefined) ?? null;
}

export const timelineTool: ToolDefinition = {
  name: "ui.timeline",
  capability: "workspace",
  operation: "timeline",
  description:
    "Show dated events on the Live Canvas: a course or project schedule, deadlines, milestones, an itinerary, a day's agenda. Give each event (ISO date, optional end for ranges, kind, source); ELISE validates the dates, keeps each event's source, flags sources that disagree, and picks timeline, calendar, agenda or Gantt-like intervals from the dates. Call it in the same response as your answer whenever the answer is mostly three or more dates. To narrow or re-arrange the schedule on screen (only exams, one month, as a calendar), call it again with focus/view and without events.",
  input: timelineInput,
  async describe() {
    return { summary: "Show a schedule" };
  },
  async run(raw, env) {
    const q = timelineInput.parse(raw);
    const w = port(env);
    const state = w.state();
    const existing = q.events ? null : currentTemporal(state);
    if (!q.events && !existing)
      throw new AppError("VALIDATION_ERROR", "There is no schedule on screen: give the events.", {
        recovery: "review",
      });
    let events: TemporalEventInput[];
    if (existing) {
      const spec = existing.payload.spec as TemporalSpec;
      events = spec.events.map((e) => ({
        ...e,
        source: e.source !== undefined ? (spec.sources?.[e.source] ?? null) : null,
      }));
    } else {
      const known = knownSources(state);
      events = q.events!.map(({ source, ...e }) => ({
        ...e,
        source: resolveSource(state, known, source),
      }));
    }
    const previousFocus = existing ? (existing.payload.spec as TemporalSpec).focus : undefined;
    // Omitted keeps the current focus; null clears it.
    const focus = q.focus === undefined ? previousFocus : (q.focus ?? undefined);
    const plan = planTemporal({
      title: q.title,
      ...(q.subtitle ? { subtitle: q.subtitle } : {}),
      events,
      view: q.view,
      ...(focus ? { focus } : {}),
      today: toLocalDateTime(env.ctx.now, env.ctx.timezone).slice(0, 10),
      explicit: Boolean(existing) || ASKED_FOR_DATES.test(env.ctx.userMessage ?? ""),
      locale: env.ctx.locale,
    });
    if (!plan.ok) throw new AppError("VALIDATION_ERROR", plan.reason, { recovery: "review" });
    const payload = PAYLOADS.visualization.parse({ spec: plan.spec });
    const id = existing?.id ?? surfaceId("visualization", `${state.intent?.id ?? "none"}:temporal`);
    w.apply([
      {
        op: "present",
        at: env.ctx.now.toISOString(),
        surface: {
          id,
          type: "visualization",
          title: q.title,
          state: "ready",
          source: {
            capability: "workspace",
            label:
              [...new Set((plan.spec.sources ?? []).map((s) => s.title.split(" · ")[0]))]
                .join(" · ")
                .slice(0, 200) || null,
          },
          ref: null,
          payload,
          intentId: state.intent?.id ?? null,
          ...draftDefaults("visualization", payload),
          // The schedule answers the question: it leads, its documents stay beside it.
          size: "large",
          priority: 86,
        },
      },
    ]);
    return {
      output: {
        shown: plan.view,
        facts: plan.facts,
        ...(plan.dropped.length ? { leftOut: plan.dropped } : {}),
        ...(plan.conflicts.length ? { conflicts: plan.conflicts } : {}),
        ...(plan.notice ? { notice: plan.notice } : {}),
        instructions:
          "The schedule is on screen with every date and its source. In your answer give only the key dates (use the facts above) and say it's on screen — never read every date. " +
          (plan.conflicts.length
            ? "Sources disagree on the dates listed in conflicts: say so and don't pick one. "
            : "") +
          (plan.notice ? "Say the notice briefly. " : "") +
          "Adding these dates to the calendar is calendar.createEvent (with its approval), only if asked.",
      },
    };
  },
};
