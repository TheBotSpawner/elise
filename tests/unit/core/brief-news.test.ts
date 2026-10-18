import { describe, expect, it } from "vitest";

import type { ToolDisplay } from "@/core/agents/tools";
import { briefCanvas } from "@/core/briefs/canvas";
import type { MorningBrief } from "@/core/briefs/morning-brief";

/**
 * "Noticias" in the Morning Brief: one visible Surface with the brief's 3–5 curated stories
 * across every topic — not one ambient (never shown) card per topic search.
 */
describe("brief news", () => {
  const read = (topic: string) => ({
    block: "news",
    tool: "web.searchNews",
    args: { query: topic, recency: "day" },
    display: {
      kind: "web_news",
      query: topic,
      recency: "day",
      retrievedAt: "2026-10-18T11:01:03Z",
      events: [{ headline: `${topic} news`, items: [] }],
    } as ToolDisplay,
  });
  const story = (topic: string, n: number) => ({
    topic,
    headline: `${topic} ${n}`,
    publishedAt: "2026-10-18",
    sources: [
      { title: `${topic} ${n}`, url: `https://n.example/${topic}/${n}`, domain: "n.example" },
    ],
  });
  const brief = {
    attention: { emails: [], tasks: [] },
    waitingOnYou: { overdue: [] },
    news: [story("IA", 1), story("IA", 2), story("OpenAI", 1), story("Microsoft", 1)],
  } as unknown as MorningBrief;

  it("one Surface, shown (priority ≥ 40), with every curated story", () => {
    const items = briefCanvas(brief, [read("IA"), read("OpenAI"), read("Microsoft")] as never);
    const news = items.filter((i) => i.display.kind === "web_news");
    expect(news).toHaveLength(1);
    expect(news[0]!.priority).toBeGreaterThanOrEqual(40);
    const d = news[0]!.display as Extract<ToolDisplay, { kind: "web_news" }>;
    expect(d.events.map((e) => e.headline)).toEqual(["IA 1", "IA 2", "OpenAI 1", "Microsoft 1"]);
    expect(d.query).toBe("IA, OpenAI, Microsoft");
  });

  it("no stories, no news Surface", () => {
    const items = briefCanvas({ ...brief, news: [] }, [read("IA")] as never);
    expect(items.some((i) => i.display.kind === "web_news")).toBe(false);
  });
});
