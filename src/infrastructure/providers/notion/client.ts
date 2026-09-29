import { AppError } from "@/core/errors";
import type { DocumentSection, NormalizedDocument } from "@/core/knowledge/model";
import type { ExternalItem } from "@/core/knowledge/sync";

/**
 * Notion as a Knowledge source (docs/architecture/09 §41-42): pages, subpages and database
 * pages become canonical text with their heading structure. Read-only; no structured Notion
 * mapping here. Endpoints per Notion's public API (version 2022-06-28).
 */
export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";
const MAX_DEPTH = 4;
const MAX_BLOCKS = 2000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
  object: "page" | "database";
  id: string;
  url?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: { type: string; database_id?: string };
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

export class NotionClient {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly onUnauthorized: () => Promise<void>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${NOTION_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await this.token()}`,
          "notion-version": NOTION_VERSION,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) {
      throw new AppError("PROVIDER_UNAVAILABLE", "Notion did not respond", { cause });
    }
    if (res.ok) return (await res.json()) as T;
    const details = { providerStatus: res.status };
    if (res.status === 401) {
      await this.onUnauthorized();
      throw new AppError("AUTH_EXPIRED", "This Notion connection needs to be reconnected", {
        recovery: "reconnect",
        details,
      });
    }
    if (res.status === 403)
      throw new AppError("PERMISSION_DENIED", "ELISE can't access this in Notion", {
        details,
        recovery: "reconnect",
      });
    if (res.status === 404)
      throw new AppError("NOT_FOUND", "That page is no longer shared with ELISE", { details });
    if (res.status === 429)
      throw new AppError("RATE_LIMITED", "Notion is limiting requests", { details });
    if (res.status >= 500)
      throw new AppError("PROVIDER_UNAVAILABLE", "Notion is unavailable", { details });
    throw new AppError("VALIDATION_ERROR", "Notion rejected the request", { details });
  }

  /** Pages and databases the user shared with ELISE, for the picker. */
  async search(query: string): Promise<NotionPage[]> {
    const res = await this.request<{ results: NotionPage[] }>("POST", "/search", {
      query,
      page_size: 50,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    });
    return res.results.filter((p) => !p.archived && !p.in_trash);
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

  private async queryDatabase(databaseId: string): Promise<NotionPage[]> {
    const out: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{ results: NotionPage[]; next_cursor: string | null }>(
        "POST",
        `/databases/${databaseId}/query`,
        { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      out.push(...res.results);
      cursor = res.next_cursor ?? undefined;
    } while (cursor && out.length < 500);
    return out;
  }

  /** The selected pages, their subpages and database pages, with their paths. */
  async listSelection(
    selection: readonly NotionSelection[],
    limit: number,
  ): Promise<ExternalItem[]> {
    const items = new Map<string, ExternalItem>();
    const addPage = (page: NotionPage, path: string[], database = false) => {
      if (page.archived || page.in_trash) return;
      items.set(page.id, {
        externalId: page.id,
        title: pageTitle(page),
        itemType:
          database || page.parent?.type === "database_id" ? "notion_database_page" : "notion_page",
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

  /** A page as a normalized document (properties first for database pages). */
  async pageDocument(pageId: string): Promise<NormalizedDocument> {
    const page = await this.page(pageId);
    const blocks = await this.tree(pageId, 0, { left: MAX_BLOCKS });
    const props = propertyLines(page);
    const sections = blocksToSections(blocks);
    return {
      title: pageTitle(page),
      sections: props.length
        ? [{ headingPath: [], page: null, blocks: props }, ...sections]
        : sections,
    };
  }
}
