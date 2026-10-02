import { describe, expect, it, vi } from "vitest";

import { chunkDocument } from "@/core/knowledge/chunking";
import {
  contentMatchesType,
  isNeedsAttention,
  parseCsv,
  parseDocument,
  parseMarkdown,
  uploadMimeType,
} from "@/infrastructure/knowledge/parsers";
import { GoogleDriveClient, toExternalItem } from "@/infrastructure/providers/google/drive";
import { GoogleHttp } from "@/infrastructure/providers/google/http";
import {
  blocksToSections,
  NotionClient,
  pageTitle,
  propertyLines,
  type NotionPage,
} from "@/infrastructure/providers/notion/client";

const enc = (s: string) => new TextEncoder().encode(s);

describe("parsers", () => {
  it("keeps Markdown heading structure for citations", () => {
    const doc = parseMarkdown(
      "Architecture",
      "Intro text.\n\n# Providers\n\nResolution rules.\n\n## Resolution\n\nExplicit first.\n\n```\n# not a heading\n```\n\n# Security\n\nRLS.",
    );
    expect(doc.sections.map((s) => s.headingPath)).toEqual([
      [],
      ["Providers"],
      ["Providers", "Resolution"],
      ["Security"],
    ]);
    expect(doc.sections[2]!.blocks.join()).toContain("# not a heading");
  });

  it("turns CSV rows into self-contained passages", () => {
    const doc = parseCsv(
      "Clients",
      'Name,Status,Notes\nINITECH,Active,"Filing, email"\nNORTHWIND,,Paused',
    );
    expect(doc.sections[0]!.blocks).toEqual([
      "Name: INITECH; Status: Active; Notes: Filing, email",
      "Name: NORTHWIND; Notes: Paused",
    ]);
  });

  it("only accepts supported upload types", () => {
    expect(uploadMimeType("Plan.PDF")).toBe("application/pdf");
    expect(uploadMimeType("notes.md")).toBe("text/markdown");
    expect(uploadMimeType("macro.docm")).toBeNull();
    expect(uploadMimeType("run.exe")).toBeNull();
  });

  it("marks documents without readable text as needing attention", async () => {
    await expect(
      parseDocument({ title: "x", mimeType: "text/plain", data: enc("  ") }),
    ).rejects.toSatisfy(isNeedsAttention);
    await expect(
      parseDocument({ title: "x", mimeType: "application/zip", data: enc("PK") }),
    ).rejects.toSatisfy(isNeedsAttention);
    await expect(
      parseDocument({ title: "x", mimeType: "application/pdf", data: enc("not a pdf") }),
    ).rejects.toSatisfy(isNeedsAttention);
  });

  it("does not trust the declared type: content must match it", async () => {
    // An HTML page renamed to .pdf, a binary renamed to .txt, a non-ZIP .docx.
    for (const [mimeType, data] of [
      ["application/pdf", enc("<html><script>alert(1)</script>" + "x".repeat(80))],
      ["text/plain", new Uint8Array([0x4d, 0x5a, 0x00, 0x00, ...enc("a".repeat(80))])],
      [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        enc("plain text pretending to be a docx".repeat(4)),
      ],
    ] as const)
      await expect(parseDocument({ title: "x", mimeType, data })).rejects.toSatisfy(
        isNeedsAttention,
      );
    expect(contentMatchesType("text/plain", enc("hola"))).toBe(true);
    expect(contentMatchesType("application/pdf", enc("%PDF-1.7 …"))).toBe(true);
  });

  it("reads plain text into chunkable paragraphs", async () => {
    const doc = await parseDocument({
      title: "Notes",
      mimeType: "text/plain",
      data: enc("First paragraph about the launch.\n\nSecond paragraph about Initech filing."),
    });
    expect(chunkDocument(doc)[0]!.content).toContain("Initech filing");
  });
});

type Call = { url: string };
function fakeHttp(routes: [RegExp, unknown][]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push({ url });
    const route = routes.find(([re]) => re.test(url));
    if (!route) return new Response("{}", { status: 404 });
    const body = route[1];
    return typeof body === "string"
      ? new Response(body, { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 });
  });
  return { http: new GoogleHttp({ accessToken: async () => "t" }, fetchImpl), calls };
}

describe("Google Drive", () => {
  it("normalizes supported files with provenance and skips the rest", () => {
    expect(
      toExternalItem(
        {
          id: "d1",
          name: "Email Filing",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-09-01T00:00:00Z",
          version: "42",
          webViewLink: "https://docs.google.com/document/d/d1",
        },
        ["Clients", "Initech"],
      ),
    ).toMatchObject({
      externalId: "d1",
      itemType: "google_doc",
      revision: "42",
      url: "https://docs.google.com/document/d/d1",
      path: ["Clients", "Initech"],
    });
    expect(toExternalItem({ id: "x", name: "a.zip", mimeType: "application/zip" }, [])).toBeNull();
  });

  it("lists a selected folder recursively, keeping the folder path", async () => {
    const { http } = fakeHttp([
      [
        /q=%27root-folder%27/,
        {
          files: [
            { id: "sub", name: "Contracts", mimeType: "application/vnd.google-apps.folder" },
            { id: "f1", name: "Plan.pdf", mimeType: "application/pdf", version: "3" },
            { id: "img", name: "logo.png", mimeType: "image/png" },
          ],
        },
      ],
      [
        /q=%27sub%27/,
        {
          files: [
            {
              id: "f2",
              name: "Sheet",
              mimeType: "application/vnd.google-apps.spreadsheet",
              version: "1",
            },
          ],
        },
      ],
    ]);
    const items = await new GoogleDriveClient(http).listSelection(
      [{ id: "root-folder", kind: "folder", name: "Initech" }],
      100,
    );
    expect(items.map((i) => [i.externalId, i.itemType, i.path.join("/")])).toEqual([
      ["f2", "google_sheet", "Initech/Contracts"],
      ["f1", "drive_file", "Initech"],
    ]);
  });

  it("exports Google Docs as Markdown to keep headings", async () => {
    const { http, calls } = fakeHttp([[/\/export\?mimeType=text%2Fmarkdown/, "# Title\n\nBody"]]);
    const content = await new GoogleDriveClient(http).content(
      "d1",
      "application/vnd.google-apps.document",
    );
    expect(content.mimeType).toBe("text/markdown");
    expect(new TextDecoder().decode(content.data)).toBe("# Title\n\nBody");
    expect(calls[0]!.url).toContain("/files/d1/export");
  });
});

describe("Notion", () => {
  it("normalizes blocks into sections with headings and nested content", () => {
    const text = (s: string) => ({ rich_text: [{ plain_text: s }] });
    const sections = blocksToSections([
      { id: "1", type: "paragraph", paragraph: text("Intro") },
      { id: "2", type: "heading_1", heading_1: text("Process") },
      {
        id: "3",
        type: "bulleted_list_item",
        bulleted_list_item: text("Step one"),
        has_children: true,
        children: [{ id: "4", type: "paragraph", paragraph: text("Detail") }],
      },
      { id: "5", type: "heading_2", heading_2: text("Unique ID") },
      { id: "6", type: "to_do", to_do: { ...text("Assign ID"), checked: true } },
      { id: "7", type: "child_page", child_page: { title: "Sub" } },
    ]);
    expect(sections).toEqual([
      { headingPath: [], page: null, blocks: ["Intro"] },
      { headingPath: ["Process"], page: null, blocks: ["• Step one", "  Detail"] },
      { headingPath: ["Process", "Unique ID"], page: null, blocks: ["[x] Assign ID"] },
    ]);
  });

  it("reads titles and database properties", () => {
    const page: NotionPage = {
      object: "page",
      id: "p",
      properties: {
        Name: { type: "title", title: [{ plain_text: "Initech onboarding" }] },
        Status: { type: "status", status: { name: "Active" } },
        Tags: { type: "multi_select", multi_select: [{ name: "client" }, { name: "email" }] },
      },
    };
    expect(pageTitle(page)).toBe("Initech onboarding");
    expect(propertyLines(page)).toEqual(["Status: Active", "Tags: client, email"]);
  });

  it("discovers selected pages, subpages and database pages", async () => {
    const pages: Record<string, unknown> = {
      root: {
        object: "page",
        id: "root",
        last_edited_time: "t1",
        properties: { title: { type: "title", title: [{ plain_text: "Initech" }] } },
      },
      sub: {
        object: "page",
        id: "sub",
        last_edited_time: "t2",
        properties: { title: { type: "title", title: [{ plain_text: "Filing" }] } },
      },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/pages/root")) return json(pages.root);
      if (url.endsWith("/pages/sub")) return json(pages.sub);
      if (url.includes("/blocks/root/children"))
        return json({
          results: [
            { id: "sub", type: "child_page" },
            { id: "db", type: "child_database" },
          ],
          next_cursor: null,
        });
      if (url.includes("/blocks/sub/children")) return json({ results: [], next_cursor: null });
      if (url.endsWith("/databases/db"))
        return json({ data_sources: [{ id: "ds1", name: "Rows" }] });
      if (url.includes("/data_sources/ds1/query"))
        return json({
          results: [
            {
              object: "page",
              id: "row",
              last_edited_time: "t3",
              parent: { type: "data_source_id", data_source_id: "ds1", database_id: "db" },
              properties: {},
            },
          ],
          next_cursor: null,
        });
      return new Response("{}", { status: 404 });
    });
    const unauthorized = vi.fn(async () => {});
    const client = new NotionClient(async () => "token", unauthorized, fetchImpl);
    const items = await client.listSelection([{ id: "root", kind: "page", name: "Initech" }], 100);
    expect(items.map((i) => [i.externalId, i.itemType, i.revision, i.path.join("/")])).toEqual([
      ["root", "notion_page", "t1", ""],
      ["sub", "notion_page", "t2", "Initech"],
      ["row", "notion_database_page", "t3", "Initech"],
    ]);
  });

  it("a revoked Notion token marks the connection for reconnection", async () => {
    const unauthorized = vi.fn(async () => {});
    const client = new NotionClient(
      async () => "token",
      unauthorized,
      async () => new Response("{}", { status: 401 }),
    );
    await expect(client.search("")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(unauthorized).toHaveBeenCalled();
  });
});
