import { describe, expect, it, vi } from "vitest";

import { ingestVersion, type IngestionPorts } from "@/core/knowledge/ingest";
import {
  LIVE,
  liveCacheKey,
  pickCandidates,
  rankRoots,
  searchTerms,
  selectPassages,
  sourceMode,
  subjectTerms,
  TtlCache,
  wantsRecent,
  type LiveCandidate,
  type LiveRoot,
} from "@/core/knowledge/live";
import { sourceRollup, sourceState } from "@/core/knowledge/source-state";
import { GoogleDriveClient } from "@/infrastructure/providers/google/drive";
import { GoogleHttp } from "@/infrastructure/providers/google/http";
import { NotionClient } from "@/infrastructure/providers/notion/client";

/** ADR-046: connected is not mirrored — Drive and Notion are read live, uploads stay indexed. */

const root = (over: Partial<LiveRoot> = {}): LiveRoot => ({
  sourceId: "s",
  spaceId: "sp",
  sourceType: "notion",
  connectionId: "c",
  id: "r",
  kind: "database",
  name: "Pipeline de Proyectos",
  ...over,
});

const candidate = (id: string, r: LiveRoot = root(), revision = "t1"): LiveCandidate => ({
  root: r,
  externalId: id,
  title: id,
  itemType: "notion_database_page",
  mimeType: null,
  url: `https://notion.so/${id}`,
  modifiedAt: revision,
  revision,
  path: [r.name],
});

describe("source modes", () => {
  it("uploads and notes are ELISE's indexed copy; Drive and Notion are read live", () => {
    expect(sourceMode("upload")).toBe("native_indexed");
    expect(sourceMode("note")).toBe("native_indexed");
    expect(sourceMode("google_drive")).toBe("external_live");
    expect(sourceMode("notion")).toBe("external_live");
  });

  it("a live source is Disponible or needs attention — never preparing or indexing", () => {
    const live = (status: string) =>
      sourceState({
        live: true,
        status,
        lastSyncedAt: null,
        counts: { ready: 0, processing: 0, attention: 0 },
      });
    expect(live("idle")).toBe("available");
    expect(live("syncing")).toBe("available");
    expect(live("ready")).toBe("available");
    expect(live("needs_attention")).toBe("needs_attention");
    expect(live("disconnected")).toBe("needs_attention");
    expect(sourceRollup("available", { ready: 0, processing: 0, attention: 224 })).toBe("ready");
  });

  it("no live source content is ever ingested, whatever asks (retry, reindex, an old job)", async () => {
    const store = {
      loadVersion: vi.fn(async () => ({
        versionId: "v",
        itemId: "i",
        workspaceId: "w",
        spaceId: "sp",
        sourceId: "s",
        versionNumber: 2,
        title: "Row",
        sourceType: "notion" as const,
        itemType: "notion_database_page" as const,
        externalId: "x",
        connectionId: "c",
        storagePath: null,
        mimeType: null,
        status: "pending",
      })),
      markProcessing: vi.fn(),
      activate: vi.fn(),
    };
    const fetch = vi.fn();
    const ports = { store, fetcher: { fetch } } as unknown as IngestionPorts;
    expect(
      await ingestVersion(ports, { workspaceId: "w", versionId: "v", attempt: 1, force: true }),
    ).toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
    expect(store.markProcessing).not.toHaveBeenCalled();
    expect(store.activate).not.toHaveBeenCalled();
  });
});

describe("query planning", () => {
  it("reads the question's terms, accent-free, and recognizes 'the latest'", () => {
    expect(searchTerms("Buscame el último proyecto de la Pipeline")).toEqual([
      "proyecto",
      "pipeline",
    ]);
    expect(wantsRecent("buscame el último proyecto")).toBe(true);
    expect(wantsRecent("lo más reciente de Firbot")).toBe(true);
    expect(wantsRecent("el cronograma de AMII")).toBe(false);
  });

  it("asks the roots the question names first, and never more than LIVE.maxRoots", () => {
    const roots = [
      root({ id: "1", name: "Empresas" }),
      root({ id: "2", name: "Pipeline Marketing" }),
      root({ id: "3", name: "Pipeline de Proyectos" }),
      root({ id: "4", name: "Contactos" }),
    ];
    const terms = searchTerms("el último proyecto de la pipeline");
    // Pipeline de Proyectos is named better (pipeline + proyecto) than Pipeline Marketing.
    expect(rankRoots(roots, terms).map((r) => r.id)).toEqual(["3"]);
    expect(rankRoots(roots, searchTerms("la pipeline")).map((r) => r.id)).toEqual(["2", "3"]);
    const many = Array.from({ length: 9 }, (_, i) => root({ id: String(i), name: `DB ${i}` }));
    expect(rankRoots(many, ["nothing"])).toHaveLength(LIVE.maxRoots);
  });

  it("searches the provider for the subject, not for the words that name the scope", () => {
    // Every file in the AMII folder says "Análisis Matemático II": the subject is "cronograma".
    expect(
      subjectTerms(searchTerms("buscame el cronograma de Análisis Matemático II"), [
        "Análisis Matemático II - Z2545 - 2026",
        "AMII",
        "Análisis Matemático II",
      ]),
    ).toEqual(["cronograma"]);
    // Only the scope: nothing to match, the provider lists the newest.
    expect(
      subjectTerms(searchTerms("el último proyecto de la Pipeline"), ["Pipeline de Proyectos"]),
    ).toEqual([]);
  });

  it("fetches at most LIVE.maxFetches candidates, the best of each root first, no duplicates", () => {
    const a = root({ id: "a", name: "A" });
    const b = root({ id: "b", name: "B" });
    const picked = pickCandidates([
      [candidate("a1", a), candidate("a2", a), candidate("a3", a), candidate("a4", a)],
      [candidate("b1", b), candidate("a1", b)],
    ]);
    expect(picked.map((c) => c.externalId)).toEqual(["a1", "b1", "a2", "a3"]);
    expect(picked).toHaveLength(LIVE.maxFetches);
  });

  it("hands over only the passages that answer; a chosen record without a match keeps its opening", () => {
    const doc = {
      title: "AMII",
      sections: [
        { headingPath: ["Intro"], page: 1, blocks: ["Bienvenidos a la materia. ".repeat(80)] },
        { headingPath: ["Cronograma"], page: 2, blocks: ["Cronograma: parcial el 12 de junio."] },
      ],
    };
    const [best] = selectPassages(doc, searchTerms("cronograma de AMII"));
    expect(best).toMatchObject({ headingPath: ["Cronograma"], page: 2, matched: true });
    const [opening] = selectPassages(doc, ["inexistente"]);
    expect(opening).toMatchObject({ headingPath: ["Intro"], matched: false });
  });
});

describe("temporary content cache (cache ≠ source of truth)", () => {
  it("a modified resource has a new revision and is never served from the old copy", () => {
    const cache = new TtlCache<string>();
    const v1 = candidate("doc", root(), "2026-10-01T10:00:00Z");
    const v2 = candidate("doc", root(), "2026-10-06T09:00:00Z");
    cache.set(liveCacheKey(v1), "old text");
    expect(cache.get(liveCacheKey(v1))).toBe("old text");
    expect(cache.get(liveCacheKey(v2))).toBeUndefined();
    cache.forget("notion:doc:");
    expect(cache.get(liveCacheKey(v1))).toBeUndefined();
  });

  it("expires, and stays bounded", () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 2, () => now);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    now = 1500;
    expect(cache.get("c")).toBeUndefined();
  });
});

describe("provider-native discovery", () => {
  it("Drive searches only inside the permitted folders, by name and full text, metadata only", async () => {
    const urls: string[] = [];
    const http = new GoogleHttp(
      { accessToken: async () => "t" },
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(
          JSON.stringify({
            files: [
              { id: "f1", name: "Cronograma AMII.pdf", mimeType: "application/pdf", version: "3" },
              { id: "img", name: "foto.png", mimeType: "image/png" },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const files = await new GoogleDriveClient(http).search({
      folderIds: ["root", "sub"],
      terms: ["cronograma"],
      recent: false,
      limit: 5,
    });
    expect(files.map((f) => f.id)).toEqual(["f1"]);
    expect(urls).toHaveLength(1);
    const q = new URL(urls[0]!).searchParams.get("q")!;
    expect(q).toContain("'root' in parents or 'sub' in parents");
    expect(q).toContain("fullText contains 'cronograma'");
    expect(q).toContain("trashed = false");
    // Nothing is downloaded or exported while searching.
    expect(urls[0]).not.toMatch(/alt=media|\/export/);
  });

  it("Drive 'the latest' is newest first; quotes in terms are escaped", async () => {
    const urls: string[] = [];
    const http = new GoogleHttp(
      { accessToken: async () => "t" },
      vi.fn(async (url: string) => (urls.push(url), new Response("{}", { status: 200 }))),
    );
    await new GoogleDriveClient(http).search({
      folderIds: ["root"],
      terms: ["o'brien"],
      recent: true,
      limit: 5,
    });
    const params = new URL(urls[0]!).searchParams;
    expect(params.get("orderBy")).toBe("modifiedTime desc");
    expect(params.get("q")).toContain("name contains 'o\\'brien'");
  });

  it("Drive catalog lists metadata and the folder scope, never content", async () => {
    const urls: string[] = [];
    const http = new GoogleHttp(
      { accessToken: async () => "t" },
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.includes("%27root%27")
          ? { files: [{ id: "sub", name: "Sub", mimeType: "application/vnd.google-apps.folder" }] }
          : { files: [{ id: "f1", name: "a.pdf", mimeType: "application/pdf", version: "1" }] };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const { items, folderIds } = await new GoogleDriveClient(http).catalog(
      [{ id: "root", kind: "folder", name: "AMII" }],
      500,
    );
    expect(items.map((i) => i.externalId)).toEqual(["f1"]);
    expect(folderIds.sort()).toEqual(["root", "sub"]);
    expect(urls.some((u) => /alt=media|\/export/.test(u))).toBe(false);
  });

  it("Notion: 'the latest' queries the database newest first and returns records with properties", async () => {
    const bodies: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/databases/db")) return json({ data_sources: [{ id: "ds" }] });
      if (url.includes("/data_sources/ds/query"))
        return json({
          results: [
            {
              object: "page",
              id: "new",
              properties: { Name: { type: "title", title: [{ plain_text: "Portal RSFA" }] } },
            },
            {
              object: "page",
              id: "old",
              properties: { Name: { type: "title", title: [{ plain_text: "Bot" }] } },
            },
          ],
        });
      return new Response("{}", { status: 404 });
    });
    const client = new NotionClient(
      async () => "t",
      async () => {},
      fetchImpl,
    );
    const pages = await client.findInDatabase("db", {
      terms: ["proyecto"],
      recent: true,
      limit: 5,
    });
    expect(pages.map((p) => p.id)).toEqual(["new", "old"]);
    const query = bodies.find((b) => b.url.includes("/query"))!.body as { sorts: unknown[] };
    expect(query.sorts).toEqual([{ timestamp: "created_time", direction: "descending" }]);
    // Records only: no block (page body) was read to find them.
    expect(bodies.some((b) => b.url.includes("/blocks/"))).toBe(false);
  });

  it("Notion: named records are found with a title filter on the data source", async () => {
    const bodies: { url: string; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      bodies.push({ url, body });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/databases/db")) return json({ data_sources: [{ id: "ds" }] });
      if (url.endsWith("/data_sources/ds"))
        return json({ properties: { Nombre: { id: "title", type: "title" } } });
      if (url.includes("/query"))
        return json({
          results: (body as { filter?: unknown }).filter
            ? [
                {
                  object: "page",
                  id: "rsfa",
                  properties: { Nombre: { type: "title", title: [{ plain_text: "RSFA Portal" }] } },
                },
              ]
            : [],
        });
      return new Response("{}", { status: 404 });
    });
    const client = new NotionClient(
      async () => "t",
      async () => {},
      fetchImpl,
    );
    const pages = await client.findInDatabase("db", { terms: ["rsfa"], recent: false, limit: 5 });
    expect(pages.map((p) => p.id)).toEqual(["rsfa"]);
    const filtered = bodies.find((b) => (b.body as { filter?: unknown } | null)?.filter)!;
    expect(filtered.body).toMatchObject({
      filter: { or: [{ property: "title", title: { contains: "rsfa" } }] },
    });
  });
});
