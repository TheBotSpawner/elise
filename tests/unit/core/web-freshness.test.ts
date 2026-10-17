import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import type { WebCapability, WebResult, WebSearchQuery } from "@/core/web/model";
import { assessEvidence, temporalIntent } from "@/core/web/temporal";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

/**
 * Freshness-aware web research (ADR-074). Generic: the regression below uses a public figure's
 * speech only as a fixture — nothing in ELISE knows about any person or topic.
 */

const NOW = new Date("2026-10-16T18:00:00Z"); // 15:00 in Buenos Aires
const TZ = "America/Argentina/Buenos_Aires";

const result = (
  url: string,
  title: string,
  publishedAt: string | null,
  kind: "web" | "news" = "web",
): WebResult => ({
  url,
  title,
  domain: new URL(url).hostname,
  snippet: `${title}.`,
  publishedAt,
  retrievedAt: NOW.toISOString(),
  kind,
  provider: "fake",
  rank: 0,
});

function setup(search: (q: WebSearchQuery, n: number) => WebResult[], userMessage: string) {
  const queries: WebSearchQuery[] = [];
  const web: WebCapability = {
    search: async (q) => {
      queries.push(q);
      return search(q, queries.length);
    },
    open: async () => {
      throw new Error("pages aren't needed here");
    },
    saveToKnowledge: async () => ({ itemId: "x", space: "y" }),
  };
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "web_search" ? web : undefined)) as ProviderFactory["get"],
  };
  return { ports, ctx: makeCtx({ now: NOW, timezone: TZ, userMessage }), queries };
}

type Out = {
  found: boolean;
  temporal?: {
    mode: string;
    confidence: string;
    searchRounds: number;
    nothingWithinWindow?: boolean;
    newest?: { date: string; withinLastDays?: number };
    rejected?: Record<string, number>;
  };
  sources: { title: string; freshness?: string }[];
  instructions: string;
};
async function search(s: ReturnType<typeof setup>, args: Record<string, unknown>): Promise<Out> {
  const out = await executeToolCall(s.ports, s.ctx, {
    name: "web.search",
    args: { inspect: false, ...args },
  });
  if (out.status !== "succeeded") throw new Error(JSON.stringify(out));
  return out.output as Out;
}

describe("temporal intent", () => {
  it("'recientemente' is a 30-day window in the user's timezone", () => {
    const i = temporalIntent("¿Hay algún discurso de Milei recientemente?", NOW, TZ);
    expect(i).toMatchObject({
      timeSensitive: true,
      mode: "recent",
      to: "2026-10-16",
      recency: "month",
    });
    expect(i.from).toBe("2026-09-16");
  });

  it("'hoy' is the user's local day, not UTC's", () => {
    const lateNight = new Date("2026-10-17T02:00:00Z"); // still the 16th in Buenos Aires
    expect(temporalIntent("¿Qué pasó hoy?", lateNight, TZ)).toMatchObject({
      mode: "today",
      from: "2026-10-16",
      recency: "day",
      hard: true,
    });
  });

  it("a timeless question isn't time-sensitive", () => {
    expect(temporalIntent("¿Qué es OAuth?", NOW, TZ).timeSensitive).toBe(false);
  });

  it("a relevant old result never counts as fresh evidence", () => {
    const intent = temporalIntent("discurso reciente", NOW, TZ);
    const a = assessEvidence(
      [result("https://a.com/2024", "Discurso de Milei en Davos", "2024-01-17")],
      "discurso Milei",
      intent,
    );
    expect(a).toMatchObject({ confidence: "low", rejected: { TOO_OLD: 1 } });
  });
});

describe("web.search on a time-sensitive question", () => {
  const MESSAGE = "ELISE, por favor, contame si hay algún discurso de Milei recientemente.";

  it("regression: an old speech doesn't answer 'recently' — ELISE searches again by itself", async () => {
    const s = setup(
      (q) =>
        q.kind === "news"
          ? [
              result(
                "https://news.example/hoy",
                "Milei dio un discurso hoy en la Bolsa",
                "2026-10-16",
                "news",
              ),
            ]
          : [result("https://archive.example/2024", "Discurso de Milei en Davos", "2024-01-17")],
      MESSAGE,
    );
    const out = await search(s, { query: "discurso Milei" });
    // The model didn't pass a recency: the user's words set the window.
    expect(s.queries[0]).toMatchObject({ recency: "month" });
    // A second, different round ran without anyone saying "buscalo de nuevo".
    expect(s.queries.some((q) => q.kind === "news")).toBe(true);
    expect(out.temporal).toMatchObject({ mode: "recent", confidence: "high", searchRounds: 2 });
    expect(out.sources[0]).toMatchObject({
      title: "Milei dio un discurso hoy en la Bolsa",
      freshness: "within_window",
    });
    expect(out.sources.find((x) => x.title.includes("Davos"))).toMatchObject({
      freshness: "older_than_asked",
    });
    expect(out.instructions).toMatch(/Never present an older_than_asked source as recent/);
    expect(out.instructions).toMatch(/publication date isn't the event's date/);
  });

  it("a credible result from today beats a stronger old one in the same round", async () => {
    const s = setup(
      () => [
        result(
          "https://archive.example/2024",
          "Discurso de Milei en Davos (completo)",
          "2024-01-17",
        ),
        result("https://news.example/hoy", "Discurso de Milei hoy", "2026-10-16"),
      ],
      MESSAGE,
    );
    const out = await search(s, { query: "discurso Milei" });
    expect(out.temporal?.searchRounds).toBe(1);
    expect(out.sources[0]!.title).toBe("Discurso de Milei hoy");
  });

  it("nothing in the window: say so, with the newest date found — never relabeled as recent", async () => {
    const s = setup(
      () => [result("https://a.example/sep", "Discurso de Milei en septiembre", "2026-09-01")],
      "¿Hubo algún discurso de Milei esta semana?",
    );
    const out = await search(s, { query: "discurso Milei" });
    expect(out.temporal).toMatchObject({
      mode: "this_week",
      confidence: "low",
      nothingWithinWindow: true,
      newest: { date: "2026-09-01", withinLastDays: 90 },
    });
    expect(out.temporal!.searchRounds).toBeLessThanOrEqual(3);
  });

  it("a timeless question pays no freshness overhead", async () => {
    const s = setup(
      () => [result("https://oauth.net/2/", "OAuth 2.0", "2012-10-01")],
      "¿Qué es OAuth?",
    );
    const out = await search(s, { query: "OAuth" });
    expect(s.queries).toHaveLength(1);
    expect(out.temporal).toBeUndefined();
  });
});

describe("web.searchNews", () => {
  it("'¿qué pasó hoy…?' narrows news to today when the model leaves recency out", async () => {
    const s = setup(() => [], "¿Qué pasó hoy con OpenAI?");
    await executeToolCall(s.ports, s.ctx, { name: "web.searchNews", args: { query: "OpenAI" } });
    expect(s.queries[0]).toMatchObject({ kind: "news", recency: "day" });
  });
});
