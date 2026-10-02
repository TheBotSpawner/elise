import { z } from "zod";

import type { ToolDefinition, ToolRunEnv } from "../agents/tools";
import { AppError } from "../errors";
import { surfaceId, type WorkspaceState } from "../workspace/model";
import { draftDefaults, PAYLOADS } from "../workspace/registry";
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
      .enum(["actual", "estimate", "target", "low", "base", "high", "scenario", "share"])
      .optional(),
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
      .enum(["auto", "compare", "trend", "distribution", "range", "progress"])
      .default("auto")
      .describe("What the chart should show; ELISE picks the chart type from the data."),
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
    observations: z.array(observation).min(1).max(40),
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
      .enum(["auto", "bar", "line", "dot", "range", "table", "pie", "kpi"])
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
    "Show numbers as a chart on the Live Canvas when it answers better than prose: comparisons across categories (analyst targets, companies, spending categories), a value over time, scenarios/ranges, shares of a whole, progress. Give the evidence (each number with its exact source URL or Surface handle, unit and horizon) and the intent; ELISE chooses the chart, checks the numbers are comparable, and computes deltas against a reference (e.g. the current level). Call it in the same response as your answer. To change an existing chart (sort, remove one, add the current value, another representation), call it again with the same metric and horizon.",
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
