import { describe, expect, it } from "vitest";

import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import type { WebCapability, WebPage, WebResult, WebSearchQuery } from "@/core/web/model";
import { isWeak, reformulations } from "@/core/web/rank";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";

const NOW = new Date("2026-10-05T15:00:00Z");

const result = (url: string, title: string, snippet = `${title} snippet`): WebResult => ({
  url,
  title,
  domain: new URL(url).hostname.replace(/^www\./, ""),
  snippet,
  publishedAt: "2026-10-05",
  retrievedAt: NOW.toISOString(),
  kind: "web",
  provider: "fake",
  rank: 0,
});

const page = (url: string): WebPage => ({
  requestedUrl: url,
  url,
  domain: new URL(url).hostname,
  title: `Page ${url}`,
  siteName: null,
  description: null,
  publishedAt: "2026-10-05T00:00:00.000Z",
  retrievedAt: NOW.toISOString(),
  text: "El dólar oficial cerró hoy a 1.050 pesos en el Banco Nación.",
  truncated: false,
});

function setup(web: WebCapability) {
  const { ports } = makePorts([]);
  ports.providers = {
    get: ((c: string) => (c === "web_search" ? web : undefined)) as ProviderFactory["get"],
  };
  return { ports, ctx: makeCtx({ now: NOW }) };
}

describe("weak evidence and reformulation", () => {
  it("weak = nothing, or no top result mentions the question's terms", () => {
    expect(isWeak([], "precio dólar hoy")).toBe(true);
    expect(isWeak([result("https://a.com/x", "Recetas de cocina")], "precio dólar hoy")).toBe(true);
    expect(isWeak([result("https://a.com/x", "Dólar hoy: precio")], "precio dólar hoy")).toBe(
      false,
    );
  });

  it("bounded: plain terms, then without recency — at most two, never dropping a site", () => {
    const r = reformulations("¿Cuál es el precio del dólar blue hoy en Argentina?", "day");
    expect(r).toHaveLength(2);
    expect(r[0]!.dropRecency).toBe(false);
    expect(r[1]!.dropRecency).toBe(true);
    expect(reformulations("dólar", null)).toEqual([]);
  });
});

describe("web.search", () => {
  it("rewords a weak first search automatically and answers from opened pages", async () => {
    const queries: WebSearchQuery[] = [];
    const opened: string[] = [];
    const web: WebCapability = {
      search: async (q) => {
        queries.push(q);
        return queries.length === 1
          ? []
          : [result("https://www.bna.com.ar/cotizacion", "Cotización dólar hoy — Banco Nación")];
      },
      open: async (url) => {
        opened.push(url);
        return page(url);
      },
      saveToKnowledge: async () => ({ itemId: "x", space: "y" }),
    };
    const { ports, ctx } = setup(web);
    const out = await executeToolCall(ports, ctx, {
      name: "web.search",
      args: { query: "¿cuál es el precio del dólar hoy?", recency: "day" },
    });
    if (out.status !== "succeeded") throw new Error(out.status);
    const o = out.output as {
      found: boolean;
      attempts: string[];
      sources: { inspected: boolean }[];
    };
    expect(o.found).toBe(true);
    expect(o.attempts).toHaveLength(2);
    expect(queries).toHaveLength(2);
    expect(opened).toEqual(["https://www.bna.com.ar/cotizacion"]);
    expect(o.sources[0]!.inspected).toBe(true);
  });

  it("gives up honestly after the bounded attempts — no invented results", async () => {
    let n = 0;
    const web: WebCapability = {
      search: async () => {
        n++;
        return [];
      },
      open: async (url) => page(url),
      saveToKnowledge: async () => ({ itemId: "x", space: "y" }),
    };
    const { ports, ctx } = setup(web);
    const out = await executeToolCall(ports, ctx, {
      name: "web.search",
      args: { query: "precio exacto del modelo XZ-9000 hoy", recency: "day" },
    });
    if (out.status !== "succeeded") throw new Error(out.status);
    expect(n).toBe(3);
    expect(out.output).toMatchObject({ found: false });
    expect(out.display).toBeUndefined();
  });

  it("reads the next results when the best pages can't be read (dynamic sites)", async () => {
    const opened: string[] = [];
    const web: WebCapability = {
      search: async () => [
        result("https://spa1.com/dolar", "Dólar hoy 1"),
        result("https://spa2.com/dolar", "Dólar hoy 2"),
        result("https://static.com/dolar", "Dólar hoy 3"),
      ],
      open: async (url) => {
        opened.push(url);
        if (url.includes("spa")) throw new Error("JS-only page");
        return page(url);
      },
      saveToKnowledge: async () => ({ itemId: "x", space: "y" }),
    };
    const { ports, ctx } = setup(web);
    const out = await executeToolCall(ports, ctx, {
      name: "web.search",
      args: { query: "dólar hoy" },
    });
    if (out.status !== "succeeded") throw new Error(out.status);
    expect(opened).toContain("https://static.com/dolar");
    const sources = (out.output as { sources: { url: string; inspected: boolean }[] }).sources;
    expect(sources.find((s) => s.url.includes("static"))?.inspected).toBe(true);
    expect(sources.filter((s) => s.url.includes("spa")).every((s) => !s.inspected)).toBe(true);
  });

  it("a domain the user named is kept on every attempt", async () => {
    const queries: WebSearchQuery[] = [];
    const web: WebCapability = {
      search: async (q) => {
        queries.push(q);
        return [];
      },
      open: async (url) => page(url),
      saveToKnowledge: async () => ({ itemId: "x", space: "y" }),
    };
    const { ports, ctx } = setup(web);
    await executeToolCall(ports, ctx, {
      name: "web.search",
      args: {
        query: "busco una notebook lenovo usada con buen precio",
        domains: ["mercadolibre.com.ar"],
      },
    });
    expect(queries.length).toBeGreaterThan(1);
    expect(queries.every((q) => q.domains?.[0] === "mercadolibre.com.ar")).toBe(true);
  });
});
