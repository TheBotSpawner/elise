import { describe, expect, it } from "vitest";

import { gatherBrief } from "@/application/morning-brief-service";
import type { ProviderFactory } from "@/core/agents/tools";
import { assembleBrief } from "@/core/briefs/morning-brief";
import type { CalendarProvider, EventQuery } from "@/core/capabilities/calendar";
import { attentionActions, attentionReason } from "@/core/knowledge/attention";
import type { KnowledgeReader } from "@/core/knowledge/model";
import {
  documentRollup,
  sourceRollup,
  sourceTotals,
  type SourceRollup,
} from "@/core/knowledge/source-state";
import { PRESETS, presetOf } from "@/core/schedules/presets";
import { morningBriefConfigSchema, scheduleInputSchema } from "@/core/schedules/schedule";
import {
  notionChoices,
  notionDocument,
  type NotionPage,
} from "@/infrastructure/providers/notion/client";

import { binding, makeCtx, makePorts } from "../../fixtures/core-fakes";

describe("logical source rollup (ADR-037)", () => {
  const counts = (ready: number, processing: number, attention: number) => ({
    ready,
    processing,
    attention,
  });

  it("a database with a few problem pages needs attention, it isn't failed", () => {
    expect(sourceRollup("up_to_date", counts(344, 0, 2))).toBe("needs_attention");
  });

  it("is failed only when nothing from it is usable", () => {
    expect(sourceRollup("up_to_date", counts(0, 0, 5))).toBe("failed");
    expect(sourceRollup("needs_attention", counts(0, 0, 0))).toBe("failed");
  });

  it("a source whose sync failed after a good one still has usable pages", () => {
    expect(sourceRollup("needs_attention", counts(37, 0, 224))).toBe("needs_attention");
  });

  it("a sync in progress is processing, never needs attention", () => {
    expect(sourceRollup("syncing", counts(10, 0, 3))).toBe("processing");
    expect(sourceRollup("preparing", counts(0, 5, 0))).toBe("processing");
    expect(sourceRollup("retrying", counts(0, 0, 0))).toBe("processing");
    expect(sourceRollup("up_to_date", counts(10, 2, 0))).toBe("processing");
  });

  it("settled and readable (or empty) is ready", () => {
    expect(sourceRollup("up_to_date", counts(342, 0, 0))).toBe("ready");
    expect(sourceRollup("up_to_date", counts(0, 0, 0))).toBe("ready");
  });

  it("uploaded documents are one source each", () => {
    expect(documentRollup("ready")).toBe("ready");
    expect(documentRollup("queued")).toBe("processing");
    expect(documentRollup("processing")).toBe("processing");
    expect(documentRollup("failed")).toBe("failed");
    expect(documentRollup("needs_attention")).toBe("needs_attention");
    // Kept its last good version after a failed new one.
    expect(documentRollup("ready", "TIMEOUT")).toBe("needs_attention");
  });

  it("Space/Section totals count sources, not their hundreds of children", () => {
    // 1 Notion database (224 problem pages), 1 Drive folder, 4 uploads (one still reading).
    const rollups: SourceRollup[] = [
      sourceRollup("needs_attention", counts(37, 0, 224)),
      sourceRollup("up_to_date", counts(12, 0, 0)),
      ...["ready", "ready", "ready", "processing"].map((s) => documentRollup(s)),
    ];
    expect(sourceTotals(rollups)).toEqual({ total: 6, ready: 4, processing: 1, attention: 1 });
  });
});

describe("attention reasons", () => {
  it("leads with plain words, never the raw code", () => {
    expect(attentionReason("VALIDATION_ERROR", "This document has no readable text")).toBe(
      "no_text",
    );
    expect(attentionReason("VALIDATION_ERROR", "ELISE can't read this file type yet")).toBe(
      "unsupported",
    );
    expect(
      attentionReason("NOT_FOUND", "That page or database is no longer shared with ELISE"),
    ).toBe("access_lost");
    expect(attentionReason("AUTH_EXPIRED", null)).toBe("reconnect");
    expect(attentionReason("BACKGROUND_STALLED", null)).toBe("stalled");
    expect(
      attentionReason("VALIDATION_ERROR", "No text was found, even with text recognition"),
    ).toBe("ocr_failed");
    expect(attentionReason("WEIRD", "boom")).toBe("unknown");
  });

  it("offers only actions that can help", () => {
    expect(attentionActions("reconnect")).toEqual(["reconnect"]);
    expect(attentionActions("stalled")).toEqual(["retry"]);
    expect(attentionActions("unsupported")).not.toContain("retry");
    expect(attentionActions("access_lost")).toContain("reconnect");
  });
});

describe("Notion picker choices", () => {
  const ds = (id: string, database: string, title: string): NotionPage => ({
    object: "data_source",
    id,
    parent: { type: "database_id", database_id: database },
    title: [{ plain_text: title }],
  });
  const page = (id: string, title: string, parent: NotionPage["parent"]): NotionPage => ({
    object: "page",
    id,
    parent,
    properties: { Name: { type: "title", title: [{ plain_text: title }] } },
  });

  it("lists databases, one per database even with several data sources", () => {
    const rows = notionChoices(
      [
        ds("ds1", "db-projects", "Projects"),
        ds("ds2", "db-projects", "Projects"),
        ds("ds3", "db-co", "Companies"),
      ],
      "database",
      new Set(["db-co"]),
    );
    expect(rows).toEqual([
      { id: "db-projects", name: "Projects", kind: "database", added: false },
      { id: "db-co", name: "Companies", kind: "database", added: true },
    ]);
  });

  it("pages are standalone pages only, never the rows of a database", () => {
    const rows = notionChoices(
      [
        page("p1", "Firbot HR Hub", { type: "workspace" }),
        page("row", "Semana 2 - IG", { type: "data_source_id", data_source_id: "ds1" }),
        page("row2", "Old row", { type: "database_id", database_id: "db" }),
      ],
      "page",
      new Set(),
    );
    expect(rows.map((r) => r.name)).toEqual(["Firbot HR Hub"]);
  });

  it("a database row with only a title is a document, not 'no readable text'", () => {
    const row = page("r", "CHOP", { type: "data_source_id", data_source_id: "ds" });
    expect(notionDocument(row, []).sections).toEqual([
      { headingPath: [], page: null, blocks: ["CHOP"] },
    ]);
    const untitled = page("u", "", { type: "data_source_id", data_source_id: "ds" });
    expect(notionDocument(untitled, []).sections).toEqual([]);
  });
});

describe("scheduled-task presets", () => {
  it("every preset is an ordinary scheduled task of the one canonical model", () => {
    for (const p of PRESETS) {
      const parsed = scheduleInputSchema.safeParse({
        name: p.id,
        actionType: "morning_brief",
        definition: p.definition,
        timezone: "America/Argentina/Buenos_Aires",
        configuration: {
          blocks: p.blocks,
          horizon: p.horizon,
          preset: p.id,
          knowledgeSpaceId: p.needsSpace ? "11111111-1111-4111-8111-111111111111" : null,
        },
      });
      expect(parsed.success, p.id).toBe(true);
    }
  });

  it("the Knowledge digest can't be created until a Space is chosen", () => {
    const r = morningBriefConfigSchema.safeParse({ blocks: ["knowledge"], horizon: "week" });
    expect(r.success).toBe(false);
  });

  it("existing Morning Briefs (no preset) parse unchanged and are recognised", () => {
    const legacy = morningBriefConfigSchema.parse({
      blocks: ["calendar", "email", "tasks"],
      sources: { calendar: "all", email: "all", tasks: "all" },
      newsTopics: "",
    });
    expect(legacy.horizon).toBe("today");
    expect(legacy.preset).toBeNull();
    expect(presetOf(legacy)).toBe("morning_brief");
    expect(presetOf({ ...legacy, preset: "weekly_planning" })).toBe("weekly_planning");
    expect(presetOf({ blocks: ["tasks"], horizon: "today" })).toBeNull();
  });
});

describe("briefing horizon and Knowledge block", () => {
  const CONN = "11111111-1111-4111-8111-111111111111";
  const SPACE = "22222222-2222-4222-8222-222222222222";

  function setup() {
    const queries: EventQuery[] = [];
    const calendar = {
      listEvents: async (q: EventQuery) => {
        queries.push(q);
        return [];
      },
    } as unknown as CalendarProvider;
    const reader = {
      spaces: async () => [{ id: SPACE, name: "Firbot", parentId: null, path: "Firbot" }],
      recentChanges: async (spaceIds: string[] | null) =>
        spaceIds?.includes(SPACE)
          ? [
              {
                itemId: "i",
                title: "Projects roadmap",
                spaceName: "Firbot",
                sourceType: "notion" as const,
                change: "updated" as const,
                versionNumber: 2,
                at: "2026-09-28T10:00:00Z",
              },
            ]
          : [],
    } as unknown as KnowledgeReader;
    const { ports } = makePorts([
      binding({ connectionId: CONN, capability: "calendar", providerKey: "google" }),
    ]);
    ports.providers = {
      get: ((capability: string) =>
        capability === "knowledge" ? reader : calendar) as ProviderFactory["get"],
    };
    const ctx = makeCtx({ origin: "schedule", now: new Date("2026-10-04T13:00:00Z") });
    return { ports, ctx, queries };
  }

  it("weekly planning reads the next seven days of the calendar", async () => {
    const { ports, ctx, queries } = setup();
    const config = morningBriefConfigSchema.parse({ blocks: ["calendar"], horizon: "week" });
    const { data } = await gatherBrief(ports, ctx, config);
    const days = (queries[0]!.timeMax.getTime() - queries[0]!.timeMin.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    expect(data.range).toEqual({ from: "2026-10-04", days: 7 });
    const brief = assembleBrief(data);
    expect(brief.period).toEqual({ from: "2026-10-04", days: 7 });
    expect(brief.today?.gaps).toEqual([]);
  });

  it("tomorrow's prep reads tomorrow only", async () => {
    const { ports, ctx, queries } = setup();
    const config = morningBriefConfigSchema.parse({ blocks: ["calendar"], horizon: "tomorrow" });
    await gatherBrief(ports, ctx, config);
    // Buenos Aires: tomorrow starts 2026-10-05 03:00 UTC.
    expect(queries[0]!.timeMin.toISOString()).toBe("2026-10-05T03:00:00.000Z");
  });

  it("a Morning Brief still reads only today and has no period", async () => {
    const { ports, ctx } = setup();
    const { data } = await gatherBrief(
      ports,
      ctx,
      morningBriefConfigSchema.parse({ blocks: ["calendar"] }),
    );
    expect(data.range).toBeUndefined();
    expect(assembleBrief(data).period).toBeUndefined();
  });

  it("the Knowledge digest summarizes the chosen Space's recent changes", async () => {
    const { ports, ctx } = setup();
    const config = morningBriefConfigSchema.parse({
      blocks: ["knowledge"],
      horizon: "week",
      knowledgeSpaceId: SPACE,
    });
    const { data, failed } = await gatherBrief(ports, ctx, config);
    expect(failed).toBe(0);
    const brief = assembleBrief(data);
    expect(brief.knowledge?.scope).toBe("Firbot");
    expect(brief.knowledge?.changes).toEqual([
      { title: "Projects roadmap", change: "updated", space: "Firbot", at: "2026-09-28T10:00:00Z" },
    ]);
  });
});
