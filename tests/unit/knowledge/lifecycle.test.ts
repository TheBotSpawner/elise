import { describe, expect, it, vi } from "vitest";

import {
  emptyEvidence,
  linksToAdd,
  matchKey,
  mentionedNodes,
  scoreEvidence,
  usableAlias,
  type KnowledgeNode,
} from "@/core/history/links";
import type { KnowledgeHit } from "@/core/knowledge/model";
import { mergeHits, preferPrimary, selectEvidence } from "@/core/knowledge/retrieval";
import { runStalled, sourceState, SOURCE_LIFECYCLE } from "@/core/knowledge/source-state";
import {
  planSync,
  syncSource,
  type ExternalItem,
  type SyncPorts,
  type SyncStore,
} from "@/core/knowledge/sync";
import { clipText, wellFormed } from "@/core/text";
import { GoogleDriveClient } from "@/infrastructure/providers/google/drive";
import { GoogleHttp } from "@/infrastructure/providers/google/http";

/** Knowledge fix milestone: finite source lifecycle, Drive ingestion, Section identity. */

const NOW = new Date("2026-10-02T15:00:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const counts = (ready: number, processing = 0, attention = 0) => ({ ready, processing, attention });

describe("source lifecycle: every state is finite", () => {
  it("preparing while the first sync is fresh; needs attention once it stalls", () => {
    const queued = { status: "queued" as const, createdAt: ago(2), startedAt: null };
    expect(
      sourceState(
        { status: "idle", lastSyncedAt: null, activeRun: queued, counts: counts(0) },
        NOW,
      ),
    ).toBe("preparing");
    const stuck = { ...queued, createdAt: ago(SOURCE_LIFECYCLE.queuedStallMinutes + 1) };
    expect(runStalled(stuck, NOW)).toBe(true);
    expect(
      sourceState({ status: "idle", lastSyncedAt: null, activeRun: stuck, counts: counts(0) }, NOW),
    ).toBe("needs_attention");
    const running = { status: "running" as const, createdAt: ago(60), startedAt: ago(5) };
    expect(runStalled(running, NOW)).toBe(false);
    expect(runStalled({ ...running, startedAt: ago(40) }, NOW)).toBe(true);
  });

  it("a never-started source doesn't stay 'preparing' forever", () => {
    const base = { status: "idle", lastSyncedAt: null, activeRun: null, counts: counts(0) };
    expect(sourceState({ ...base, createdAt: ago(1) }, NOW)).toBe("preparing");
    expect(sourceState({ ...base, createdAt: ago(60) }, NOW)).toBe("needs_attention");
  });

  it("a refresh keeps a usable source 'syncing'; a READY source waiting for its next check is up to date", () => {
    const run = { status: "running" as const, createdAt: ago(1), startedAt: ago(1) };
    expect(
      sourceState(
        { status: "syncing", lastSyncedAt: ago(90), activeRun: run, counts: counts(24) },
        NOW,
      ),
    ).toBe("syncing");
    expect(
      sourceState(
        { status: "ready", lastSyncedAt: ago(90), activeRun: null, counts: counts(24) },
        NOW,
      ),
    ).toBe("up_to_date");
  });

  it("uploads and notes are containers, never 'preparing' or 'needs attention' by age", () => {
    expect(
      sourceState(
        {
          container: true,
          status: "ready",
          lastSyncedAt: null,
          createdAt: ago(600),
          counts: counts(1),
        },
        NOW,
      ),
    ).toBe("up_to_date");
  });
});

const ext = (id: string, revision = "1"): ExternalItem => ({
  externalId: id,
  title: `${id}.pdf`,
  itemType: "drive_file",
  mimeType: "application/pdf",
  url: null,
  modifiedAt: null,
  revision,
  path: ["Folder"],
});

describe("incremental sync is idempotent", () => {
  it("unchanged files do nothing; changed, new, removed and stalled ones do", () => {
    const plan = planSync(
      [
        { id: "a", externalId: "A", status: "ready", revision: "1" },
        { id: "b", externalId: "B", status: "ready", revision: "1" },
        { id: "c", externalId: "C", status: "ready", revision: "1" },
        {
          id: "d",
          externalId: "D",
          status: "needs_attention",
          revision: "1",
          errorCode: "BACKGROUND_STALLED",
        },
        {
          id: "e",
          externalId: "E",
          status: "needs_attention",
          revision: "1",
          errorCode: "VALIDATION_ERROR",
        },
      ],
      [ext("A"), ext("B", "2"), ext("D"), ext("E"), ext("F")],
    );
    expect(plan.created.map((i) => i.externalId)).toEqual(["F"]);
    // Changed (B) refreshes its catalog entry; D and E still carry a pre-ADR-046 ingestion state,
    // so their entries are refreshed once (to plain catalog metadata) and then left alone.
    expect(plan.updated.map((u) => u.itemId)).toEqual(["b", "d", "e"]);
    expect(plan.removed).toEqual(["c"]);
    expect(
      planSync([{ id: "a", externalId: "A", status: "ready", revision: "1" }], [ext("A")]),
    ).toEqual({
      created: [],
      updated: [],
      removed: [],
    });
  });

  it("a source that can't be listed fails its run, removes nothing and is traced", async () => {
    const finish = vi.fn();
    const markRemoved = vi.fn();
    const log = vi.fn();
    const store = {
      loadRun: async () => ({
        run: { id: "r", workspaceId: "w", sourceId: "s", status: "queued" },
        source: {
          id: "s",
          workspaceId: "w",
          spaceId: "sp",
          sourceType: "google_drive",
          connectionId: "c",
          configuration: {},
        },
      }),
      markRunning: async () => undefined,
      knownItems: async () => [],
      catalogItem: vi.fn(),
      updateCatalogItem: vi.fn(),
      markRemoved,
      finish,
    } as unknown as SyncStore;
    const ports: SyncPorts = {
      store,
      lister: {
        list: async () =>
          Promise.reject(Object.assign(new Error("x"), { code: "PROVIDER_UNAVAILABLE" })),
      },
      now: () => NOW,
      log,
    };
    await syncSource(ports, { workspaceId: "w", syncRunId: "r" });
    expect(markRemoved).not.toHaveBeenCalled();
    expect(finish.mock.calls[0]![2]).toMatchObject({
      status: "failed",
      sourceStatus: "needs_attention",
    });
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      "knowledge.sync_started",
      "knowledge.sync_failed",
    ]);
    expect(log.mock.calls[1]![1]).toMatchObject({
      source_id: "s",
      provider: "google_drive",
      stage: "list",
    });
  });
});

function fakeHttp(routes: [RegExp, (url: string) => unknown][]) {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    urls.push(url);
    const route = routes.find(([re]) => re.test(url));
    if (!route) return new Response("{}", { status: 404 });
    const body = route[1](url);
    return typeof body === "string"
      ? new Response(body, { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 });
  });
  return { http: new GoogleHttp({ accessToken: async () => "t" }, fetchImpl), urls };
}

describe("Google Drive ingestion", () => {
  it("follows every page of a folder", async () => {
    const { http, urls } = fakeHttp([
      [
        /q=%27root%27/,
        (url) =>
          url.includes("pageToken=p2")
            ? { files: [{ id: "f3", name: "c.pdf", mimeType: "application/pdf", version: "1" }] }
            : {
                nextPageToken: "p2",
                files: [
                  { id: "f1", name: "a.pdf", mimeType: "application/pdf", version: "1" },
                  { id: "f2", name: "b.pdf", mimeType: "application/pdf", version: "1" },
                ],
              },
      ],
    ]);
    const items = await new GoogleDriveClient(http).listSelection(
      [{ id: "root", kind: "folder", name: "R" }],
      500,
    );
    expect(items.map((i) => i.externalId)).toEqual(["f1", "f2", "f3"]);
    expect(urls.filter((u) => u.includes("pageToken=p2"))).toHaveLength(1);
  });

  it("reads a folder reachable twice only once (no cycles, no duplicates)", async () => {
    const { http, urls } = fakeHttp([
      [
        /q=%27root%27/,
        () => ({
          files: [{ id: "sub", name: "Sub", mimeType: "application/vnd.google-apps.folder" }],
        }),
      ],
      [
        /q=%27sub%27/,
        () => ({ files: [{ id: "f1", name: "a.pdf", mimeType: "application/pdf", version: "1" }] }),
      ],
    ]);
    const items = await new GoogleDriveClient(http).listSelection(
      [
        { id: "root", kind: "folder", name: "Root" },
        { id: "sub", kind: "folder", name: "Sub" },
      ],
      500,
    );
    expect(items).toHaveLength(1);
    expect(urls.filter((u) => /q=%27sub%27/.test(u))).toHaveLength(1);
  });

  it("exports Sheets and Slides as text; downloads ordinary files as bytes", async () => {
    const { http, urls } = fakeHttp([
      [/\/export\?mimeType=text%2Fcsv/, () => "a,b\n1,2"],
      [/\/export\?mimeType=text%2Fplain/, () => "Slide 1"],
      [/alt=media/, () => "%PDF-1.7"],
    ]);
    const drive = new GoogleDriveClient(http);
    expect((await drive.content("s1", "application/vnd.google-apps.spreadsheet")).mimeType).toBe(
      "text/csv",
    );
    expect((await drive.content("p1", "application/vnd.google-apps.presentation")).mimeType).toBe(
      "text/plain",
    );
    expect((await drive.content("f1", "application/pdf")).mimeType).toBe("application/pdf");
    expect(urls[2]).toContain("/files/f1?alt=media");
    await expect(drive.content("z", "application/zip")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });
});

const node = (
  id: string,
  name: string,
  parent: KnowledgeNode | null,
  aliases: string[] = [],
): KnowledgeNode => ({
  id,
  name,
  parentId: parent?.id ?? null,
  parentName: parent?.name ?? null,
  archived: false,
  aliases,
});
const UTN = node("utn", "UTN", null);
const AMII = node("amii", "AMII", UTN, ["Análisis Matemático II"]);
const NODES = [UTN, AMII, node("sis", "Análisis de Sistemas", UTN, ["Análisis de Sistemas 2026"])];

describe("Section identity: names, descriptions and numerals", () => {
  it("normalizes case, accents, punctuation and Roman numerals II–IX", () => {
    expect(matchKey("Análisis Matemático II")).toBe("analisis matematico 2");
    expect(matchKey("ANALISIS matematico 2")).toBe("analisis matematico 2");
    // "I", "V" and "X" stay words (pronouns, letters), not numbers.
    expect(matchKey("Capítulo I")).toBe("capitulo i");
  });

  it("the real case: 'análisis matemático 2' is UTN › AMII; 'AMII' too; nothing else", () => {
    expect(
      mentionedNodes("Elis, ¿podrías consultar el cronograma de análisis matemático 2?", NODES),
    ).toEqual(["amii"]);
    expect(mentionedNodes("Necesito los TP de AMII", NODES)).toEqual(["amii"]);
    expect(mentionedNodes("Tengo examen de análisis", NODES)).toEqual([]);
  });

  it("only short identity phrases count as aliases", () => {
    expect(usableAlias("Análisis Matemático II")).toBe(true);
    expect(usableAlias("Personal")).toBe(false);
    expect(usableAlias("Todo lo relacionado a UTN y mi carrera de Ingeniería en Sistemas")).toBe(
      false,
    );
  });
});

describe("automatic History tags", () => {
  it("one alias mention links the Section (its Space shows with it)", () => {
    const e = emptyEvidence();
    e.mentionTurns.set("amii", 1);
    expect(scoreEvidence(e, NODES)).toMatchObject([{ spaceId: "amii", evidence: ["mentions"] }]);
  });

  it("Knowledge used in one turn is strong evidence on its own", () => {
    const e = emptyEvidence();
    e.knowledgeTurns.set("amii", 1);
    e.knowledgePassages.set("amii", 2);
    expect(scoreEvidence(e, NODES)).toMatchObject([{ spaceId: "amii", confidence: 0.8 }]);
  });

  it("never re-adds a link the user removed", () => {
    const scored = [{ spaceId: "amii", confidence: 0.9, evidence: ["mentions"] }];
    const removed = [
      {
        thread: { kind: "conversation" as const, id: "c" },
        spaceId: "amii",
        source: "manual" as const,
        state: "removed" as const,
        updatedAt: ago(5),
      },
    ];
    expect(linksToAdd(scored, removed)).toEqual([]);
  });
});

const hit = (chunkId: string, spaceId: string, score: number): KnowledgeHit => ({
  chunkId,
  itemId: chunkId,
  versionId: "v",
  versionNumber: 1,
  title: chunkId,
  itemType: "drive_file",
  sourceType: "google_drive",
  sourceUrl: null,
  spaceId,
  spaceName: spaceId,
  headingPath: [],
  page: null,
  content: "x",
  similarity: 0.5,
  keywordMatched: true,
  score,
});

describe("Section-first retrieval with inheritance", () => {
  it("inherited candidates are always considered and deduplicated", () => {
    const own = Array.from({ length: 16 }, (_, i) => hit(`amii-${i}`, "amii", 0.025 - i * 0.0005));
    const merged = mergeHits(own, [hit("calendar", "utn", 0.033), hit("amii-0", "utn", 0.03)]);
    expect(merged).toHaveLength(17);
    const evidence = selectEvidence(preferPrimary(merged, ["amii"]));
    expect(evidence.map((h) => h.chunkId)).toContain("calendar");
    expect(evidence[0]!.spaceId).toBe("utn");
  });
});

describe("text that is safe to store", () => {
  it("never splits a two-unit character, and repairs one already split", () => {
    const math = "valor de 𝑥 en 𝑓(𝑥)";
    for (let n = 2; n < math.length; n++) expect(clipText(math, n).isWellFormed()).toBe(true);
    const split = { content: "𝑥".slice(0, 1), nested: ["ok", "𝑓".slice(1)] };
    const fixed = wellFormed(split);
    expect(JSON.stringify(fixed)).not.toMatch(/\\ud[89a-f]/i);
    expect(fixed.nested[0]).toBe("ok");
  });
});
