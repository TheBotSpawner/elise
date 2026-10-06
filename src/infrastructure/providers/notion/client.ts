import type { DocumentSection, NormalizedDocument } from "@/core/knowledge/model";
import type { ExternalItem } from "@/core/knowledge/sync";

import { NotionHttp, type FetchLike } from "./http";

export { NOTION_API, NOTION_VERSION, type FetchLike } from "./http";

/**
 * Notion as a Knowledge source (docs/architecture/09 §41-42): pages, subpages and database
 * pages become canonical text with their heading structure. Read-only. Structured records
 * (fields, filters, writes) live in ./structured.ts. API version: see ./http.ts.
 */
const MAX_DEPTH = 4;
const MAX_BLOCKS = 2000;

export interface NotionSelection {
  id: string;
  kind: "page" | "database";
  name: string;
}

interface RichText {
  plain_text?: string;
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [key: string]: unknown;
}

export interface NotionPage {
  object: "page" | "database" | "data_source";
  id: string;
  url?: string;
  last_edited_time?: string;
  in_trash?: boolean;
  is_archived?: boolean;
  parent?: { type: string; database_id?: string; data_source_id?: string };
  properties?: Record<string, { type: string; [key: string]: unknown }>;
  title?: RichText[];
}

const plain = (rich: unknown) =>
  Array.isArray(rich) ? (rich as RichText[]).map((r) => r.plain_text ?? "").join("") : "";

export function pageTitle(page: NotionPage): string {
  if (page.title) return plain(page.title) || "Untitled";
  const title = Object.values(page.properties ?? {}).find((p) => p.type === "title");
  return (title && plain(title.title)) || "Untitled";
}

/** A database page's properties, as "Name: value" lines, so they are searchable too. */
export function propertyLines(page: NotionPage): string[] {
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(page.properties ?? {})) {
    let value = "";
    switch (prop.type) {
      case "rich_text":
        value = plain(prop.rich_text);
        break;
      case "select":
      case "status":
        value = (prop[prop.type] as { name?: string } | null)?.name ?? "";
        break;
      case "multi_select":
        value = ((prop.multi_select as { name: string }[]) ?? []).map((o) => o.name).join(", ");
        break;
      case "date":
        value = (prop.date as { start?: string } | null)?.start ?? "";
        break;
      case "number":
      case "url":
      case "email":
      case "phone_number":
      case "checkbox":
        value =
          prop[prop.type] === null || prop[prop.type] === undefined ? "" : String(prop[prop.type]);
        break;
    }
    if (value && prop.type !== "title") lines.push(`${name}: ${value}`);
  }
  return lines;
}

/** Notion blocks → sections: headings open sections; text blocks become paragraphs. */
export function blocksToSections(
  blocks: readonly (NotionBlock & { children?: NotionBlock[] })[],
  base: string[] = [],
): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const path = [...base];
  let current: DocumentSection = { headingPath: [...base], page: null, blocks: [] };
  const text = (b: NotionBlock) =>
    plain((b[b.type] as { rich_text?: unknown } | undefined)?.rich_text);

  const visit = (list: readonly (NotionBlock & { children?: NotionBlock[] })[], indent: string) => {
    for (const b of list) {
      const heading = /^heading_([123])$/.exec(b.type);
      if (heading) {
        if (current.blocks.length) sections.push(current);
        const level = Number(heading[1]);
        path.length = base.length + level - 1;
        path[base.length + level - 1] = text(b);
        current = { headingPath: path.filter(Boolean), page: null, blocks: [] };
      } else {
        let line = "";
        switch (b.type) {
          case "paragraph":
          case "quote":
          case "callout":
          case "toggle":
            line = text(b);
            break;
          case "bulleted_list_item":
          case "numbered_list_item":
            line = `• ${text(b)}`;
            break;
          case "to_do":
            line = `${(b.to_do as { checked?: boolean }).checked ? "[x]" : "[ ]"} ${text(b)}`;
            break;
          case "code":
            line = text(b);
            break;
          case "table_row":
            line = ((b.table_row as { cells?: unknown[] }).cells ?? []).map(plain).join(" | ");
            break;
          case "bookmark":
          case "link_preview":
            line = (b[b.type] as { url?: string }).url ?? "";
            break;
        }
        if (line.trim()) current.blocks.push(`${indent}${line.trim()}`);
      }
      // Child pages/databases are separate Knowledge items; other children are nested content.
      if (b.children?.length && b.type !== "child_page" && b.type !== "child_database") {
        visit(b.children, `${indent}  `);
      }
    }
  };
  visit(blocks, "");
  if (current.blocks.length) sections.push(current);
  return sections;
}

export interface NotionChoice {
  id: string;
  name: string;
  kind: "database" | "page";
  /** Already a source of this Space/Section: adding it again would duplicate it. */
  added: boolean;
}

/** Search results → picker rows: data sources fold into their database; rows are left out. */
export function notionChoices(
  results: readonly NotionPage[],
  kind: "database" | "page",
  added: ReadonlySet<string>,
): NotionChoice[] {
  const seen = new Set<string>();
  return results.flatMap((p) => {
    let id: string;
    if (kind === "database") {
      if (p.object === "page") return [];
      id = p.object === "data_source" ? (p.parent?.database_id ?? p.id) : p.id;
    } else {
      // Database rows are a database's content, not standalone pages.
      if (p.object !== "page") return [];
      if (p.parent?.type === "data_source_id" || p.parent?.type === "database_id") return [];
      id = p.id;
    }
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: pageTitle(p), kind, added: added.has(id) }];
  });
}

export function notionDocument(
  page: NotionPage,
  blocks: readonly (NotionBlock & { children?: NotionBlock[] })[],
): NormalizedDocument {
  const title = pageTitle(page);
  const props = propertyLines(page);
  const sections = blocksToSections(blocks);
  const all = props.length
    ? [{ headingPath: [], page: null, blocks: props }, ...sections]
    : sections;
  return {
    title,
    // An untitled empty row stays empty (nothing to find), and says so.
    sections:
      all.length || title === "Untitled" ? all : [{ headingPath: [], page: null, blocks: [title] }],
  };
}

export class NotionClient {
  private readonly http: NotionHttp;

  constructor(
    token: () => Promise<string>,
    onUnauthorized: () => Promise<void>,
    fetchImpl: FetchLike = fetch,
  ) {
    this.http = new NotionHttp(token, onUnauthorized, fetchImpl);
  }

  private request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    // Knowledge only reads (search and query are reads too).
    return this.http.request<T>(method, path, body, true);
  }

  /**
   * What the user shared with ELISE, for the picker: data sources (each points at its database
   * in `parent.database_id`) or pages. Search only filters by "page" | "data_source" (API
   * 2026-03-11); a few pages of results, newest first.
   */
  async search(query: string, object?: "page" | "data_source"): Promise<NotionPage[]> {
    const out: NotionPage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const res = await this.request<{ results: NotionPage[]; next_cursor: string | null }>(
        "POST",
        "/search",
        {
          query,
          page_size: 100,
          sort: { direction: "descending", timestamp: "last_edited_time" },
          ...(object ? { filter: { property: "object", value: object } } : {}),
          ...(cursor ? { start_cursor: cursor } : {}),
        },
      );
      out.push(...res.results);
      cursor = res.next_cursor ?? undefined;
      if (!cursor) break;
    }
    return out.filter((p) => !p.in_trash && !p.is_archived);
  }

  async page(pageId: string): Promise<NotionPage> {
    return this.request<NotionPage>("GET", `/pages/${pageId}`);
  }

  private async children(blockId: string): Promise<NotionBlock[]> {
    const out: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{ results: NotionBlock[]; next_cursor: string | null }>(
        "GET",
        `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      );
      out.push(...res.results);
      cursor = res.next_cursor ?? undefined;
    } while (cursor && out.length < MAX_BLOCKS);
    return out;
  }

  private async tree(blockId: string, depth: number, budget: { left: number }) {
    const blocks: (NotionBlock & { children?: NotionBlock[] })[] = await this.children(blockId);
    budget.left -= blocks.length;
    if (depth >= MAX_DEPTH) return blocks;
    for (const b of blocks) {
      if (budget.left <= 0) break;
      if (b.has_children && b.type !== "child_page" && b.type !== "child_database") {
        b.children = await this.tree(b.id, depth + 1, budget);
      }
    }
    return blocks;
  }

  /** A database's rows: a database holds one or more data sources, each queried in turn. */
  private async queryDatabase(databaseId: string): Promise<NotionPage[]> {
    const database = await this.request<{ data_sources?: { id: string }[] }>(
      "GET",
      `/databases/${databaseId}`,
    );
    const out: NotionPage[] = [];
    for (const source of database.data_sources ?? []) {
      let cursor: string | undefined;
      do {
        const res = await this.request<{ results: NotionPage[]; next_cursor: string | null }>(
          "POST",
          `/data_sources/${source.id}/query`,
          { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        );
        out.push(...res.results);
        cursor = res.next_cursor ?? undefined;
      } while (cursor && out.length < 500);
      if (out.length >= 500) break;
    }
    return out;
  }

  /** The data sources of a database (API 2026-03-11: a database holds one or more). */
  async dataSources(databaseId: string): Promise<string[]> {
    const database = await this.request<{ data_sources?: { id: string }[] }>(
      "GET",
      `/databases/${databaseId}`,
    );
    return (database.data_sources ?? []).map((s) => s.id);
  }

  /** Databases placed directly on a page ("Pipeline de Proyectos" page → its inline database). */
  async childDatabases(pageId: string): Promise<{ id: string; title: string }[]> {
    const res = await this.request<{ results: NotionBlock[] }>(
      "GET",
      `/blocks/${pageId}/children?page_size=100`,
    );
    return res.results
      .filter((b) => b.type === "child_database")
      .map((b) => ({ id: b.id, title: (b.child_database as { title?: string })?.title ?? "" }));
  }

  /**
   * A database's records that can answer a question, queried live (ADR-046): its data sources'
   * titles filtered by the terms, plus the most recent records scored on their properties, so a
   * question about a field ("cliente: Acme") or "the latest one" works without reading every
   * row. Records come back with their properties; their bodies are fetched only if chosen.
   */
  async findInDatabase(
    databaseId: string,
    q: { terms: readonly string[]; recent: boolean; limit: number; dataSources?: string[] },
  ): Promise<NotionPage[]> {
    const sources = q.dataSources ?? (await this.dataSources(databaseId));
    const out = new Map<string, { page: NotionPage; score: number; order: number }>();
    let order = 0;
    const add = (page: NotionPage, score: number) => {
      if (page.in_trash || page.is_archived) return;
      const prev = out.get(page.id);
      if (!prev || prev.score < score)
        out.set(page.id, { page, score, order: prev?.order ?? order++ });
    };
    const lines = (p: NotionPage) => `${pageTitle(p)} ${propertyLines(p).join(" ")}`;
    const hits = (p: NotionPage) =>
      q.terms.filter((t) =>
        lines(p).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").includes(t),
      ).length;
    for (const source of sources.slice(0, 2).map((id) => ({ id }))) {
      if (q.terms.length && !q.recent) {
        const schema = await this.request<{
          properties?: Record<string, { id: string; type: string }>;
        }>("GET", `/data_sources/${source.id}`);
        const title = Object.values(schema.properties ?? {}).find((p) => p.type === "title");
        if (title) {
          const res = await this.request<{ results: NotionPage[] }>(
            "POST",
            `/data_sources/${source.id}/query`,
            {
              page_size: q.limit,
              filter: { or: q.terms.map((t) => ({ property: title.id, title: { contains: t } })) },
              sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
            },
          );
          for (const p of res.results) add(p, 10 + hits(p));
        }
      }
      // Newest records: "the latest", and fields that match without the title matching.
      const recent = await this.request<{ results: NotionPage[] }>(
        "POST",
        `/data_sources/${source.id}/query`,
        { page_size: 25, sorts: [{ timestamp: "created_time", direction: "descending" }] },
      );
      recent.results.forEach((p, i) => {
        const h = hits(p);
        if (q.recent) add(p, 20 - i + h);
        else if (h > 0) add(p, h);
      });
    }
    return [...out.values()]
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, q.limit)
      .map((x) => x.page);
  }

  /** The selected pages, their subpages and database pages, with their paths. */
  async listSelection(
    selection: readonly NotionSelection[],
    limit: number,
  ): Promise<ExternalItem[]> {
    const items = new Map<string, ExternalItem>();
    const addPage = (page: NotionPage, path: string[], database = false) => {
      if (page.in_trash || page.is_archived) return;
      items.set(page.id, {
        externalId: page.id,
        title: pageTitle(page),
        itemType:
          database || page.parent?.type === "database_id" || page.parent?.type === "data_source_id"
            ? "notion_database_page"
            : "notion_page",
        mimeType: null,
        url: page.url ?? null,
        modifiedAt: page.last_edited_time ?? null,
        revision: page.last_edited_time ?? "",
        path,
      });
    };
    const walkPage = async (pageId: string, path: string[], depth: number) => {
      if (items.size >= limit || depth > MAX_DEPTH) return;
      const page = await this.page(pageId);
      addPage(page, path);
      const title = pageTitle(page);
      for (const block of await this.children(pageId)) {
        if (items.size >= limit) return;
        if (block.type === "child_page") await walkPage(block.id, [...path, title], depth + 1);
        if (block.type === "child_database") await walkDatabase(block.id, [...path, title]);
      }
    };
    const walkDatabase = async (databaseId: string, path: string[]) => {
      for (const page of await this.queryDatabase(databaseId)) {
        if (items.size >= limit) return;
        addPage(page, path, true);
      }
    };
    for (const root of selection) {
      if (root.kind === "page") await walkPage(root.id, [], 0);
      else await walkDatabase(root.id, [root.name]);
    }
    return [...items.values()];
  }

  /**
   * A page as a normalized document (properties first for database pages). A database row
   * that is only a title ("CHOP" in Empresas) is still a document: its title is its content,
   * so it is findable instead of "no readable text" (ADR-037).
   */
  async pageDocument(pageId: string, maxBlocks: number = MAX_BLOCKS): Promise<NormalizedDocument> {
    // Page (properties) and body in parallel: a live read is on the user's clock.
    const [page, blocks] = await Promise.all([
      this.page(pageId),
      this.tree(pageId, 0, { left: maxBlocks }),
    ]);
    return notionDocument(page, blocks);
  }
}
