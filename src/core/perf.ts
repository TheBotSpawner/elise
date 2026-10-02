/**
 * Turn performance (docs/performance): high-level timing spans of one ELISE turn, relative to
 * the moment the request arrived. Numbers and names only — never message content, queries or
 * tool arguments. Stored with the run (ai_runs.token_usage.perf) and logged as `turn.perf`.
 */

export interface ModelCallStats {
  model: string | null;
  profile: string;
  reasoning: string | null;
  serviceTier: string | null;
  /** ms from request start. */
  start: number;
  firstEvent: number | null;
  firstText: number | null;
  end: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  toolsExposed: number;
  toolCalls: number;
}

export interface ToolStats {
  name: string;
  start: number;
  end: number;
  ok: boolean;
}

export interface TurnPerfSummary {
  modality: string;
  intent: string | null;
  profile: string | null;
  /** Setup and context steps, ms (duration). */
  spans: Record<string, number>;
  /** Moments, ms from request start. */
  marks: Record<string, number>;
  models: ModelCallStats[];
  tools: ToolStats[];
  metrics: {
    ttfbServer: number | null;
    ttft: number | null;
    firstEvent: number | null;
    firstSurface: number | null;
    contextBuild: number | null;
    modelMs: number;
    toolMs: number;
    total: number | null;
    modelCalls: number;
    toolCalls: number;
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    toolsExposed: number;
  };
}

export class TurnPerf {
  private readonly spans: Record<string, number> = {};
  private readonly marks: Record<string, number> = {};
  private readonly models: ModelCallStats[] = [];
  private readonly tools: ToolStats[] = [];
  intent: string | null = null;
  profile: string | null = null;

  constructor(
    readonly origin: number = Date.now(),
    readonly modality: string = "text",
    private readonly clock: () => number = Date.now,
  ) {}

  /** ms since the request arrived. */
  now(): number {
    return this.clock() - this.origin;
  }

  /** First occurrence wins: "first_text", "first_surface"… */
  mark(name: string, at: number = this.now()) {
    if (!(name in this.marks)) this.marks[name] = at;
  }

  /** Times an awaited step (its duration, and when it ended). */
  async time<T>(name: string, work: PromiseLike<T> | (() => PromiseLike<T>)): Promise<T> {
    const start = this.clock();
    try {
      return await (typeof work === "function" ? work() : work);
    } finally {
      this.spans[name] = (this.spans[name] ?? 0) + (this.clock() - start);
    }
  }

  span(name: string, ms: number) {
    this.spans[name] = (this.spans[name] ?? 0) + ms;
  }

  model(stats: ModelCallStats) {
    this.models.push(stats);
  }

  tool(stats: ToolStats) {
    this.tools.push(stats);
  }

  summary(): TurnPerfSummary {
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const m = this.marks;
    return {
      modality: this.modality,
      intent: this.intent,
      profile: this.profile,
      spans: { ...this.spans },
      marks: { ...m },
      models: [...this.models],
      tools: [...this.tools],
      metrics: {
        ttfbServer: m.stream_start ?? null,
        ttft: m.first_text ?? null,
        firstEvent: m.first_event ?? null,
        firstSurface: m.first_surface ?? null,
        contextBuild: m.context_built != null ? m.context_built - (m.auth ?? 0) : null,
        modelMs: sum(this.models.map((x) => x.end - x.start)),
        toolMs: sum(this.tools.map((x) => x.end - x.start)),
        total: m.complete ?? null,
        modelCalls: this.models.length,
        toolCalls: this.tools.length,
        inputTokens: sum(this.models.map((x) => x.inputTokens)),
        cachedTokens: sum(this.models.map((x) => x.cachedTokens)),
        outputTokens: sum(this.models.map((x) => x.outputTokens)),
        toolsExposed: this.models[0]?.toolsExposed ?? 0,
      },
    };
  }
}

/** Percentile of a sample (nearest-rank); null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))]!;
}
