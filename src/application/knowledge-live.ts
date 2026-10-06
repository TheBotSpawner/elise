import "server-only";

import { toAppError } from "@/core/errors";
import {
  LIVE,
  liveCacheKey,
  liveScore,
  pickCandidates,
  rankRoots,
  searchTerms,
  selectPassages,
  subjectTerms,
  termScore,
  TtlCache,
  wantsRecent,
  type LiveCandidate,
  type LiveRoot,
} from "@/core/knowledge/live";
import {
  spacePaths,
  type KnowledgeHit,
  type LiveSearchOutcome,
  type NormalizedDocument,
} from "@/core/knowledge/model";
import type { ExternalItem, SyncSource } from "@/core/knowledge/sync";
import { logger } from "@/infrastructure/observability/logger";
import { GoogleDriveClient, toExternalItem } from "@/infrastructure/providers/google/drive";
import {
  pageTitle,
  type NotionClient,
  type NotionPage,
} from "@/infrastructure/providers/notion/client";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { SupabaseKnowledgeStore } from "@/infrastructure/supabase/repositories/knowledge-store";

import type { AuthContext } from "./auth-context";
import { googleHttpFor, notionClientFor } from "./elise";
import { readDocument } from "./extraction-service";

/**
 * Live retrieval over connected sources (ADR-046, Parts D-G). Staged and bounded:
 *   1. the Spaces in scope give their Drive/Notion sources, each root one thing to ask;
 *   2. roots the question names go first (at most LIVE.maxRoots);
 *   3. each root's provider searches itself — Drive's name/full-text index inside the permitted
 *      folders, Notion's database query with title filters and sorts — metadata only;
 *   4. the best candidates across roots (at most LIVE.maxFetches) are read now: Notion blocks,
 *      Drive export/download through the shared extraction (OCR when needed), never stored;
 *   5. the passages that answer are cited with the original's URL and catalog entry.
 * Recently read content is cached in memory under the provider's revision: a changed document
 * has a new revision, so a stale copy is never served.
 */

const contentCache = new TtlCache<NormalizedDocument>();
/**
 * Structure, not content: which databases sit on a Notion page and which data sources a database
 * has. It changes rarely, and remembering it for a few minutes saves sequential round trips.
 */
const structureCache = new TtlCache<string[]>();

/** Notion caps a live page read: properties plus the first blocks answer most questions. */
const LIVE_PAGE_BLOCKS = 300;

interface SelectionEntry {
  id: string;
  kind: LiveRoot["kind"];
  name: string;
}

function selectionOf(configuration: unknown): SelectionEntry[] {
  const s = (configuration as { selection?: SelectionEntry[] } | null)?.selection;
  return Array.isArray(s) ? s.filter((x) => x && typeof x.id === "string") : [];
}

function folderScope(configuration: unknown, root: LiveRoot): string[] {
  const ids = (configuration as { catalog?: { folderIds?: unknown } } | null)?.catalog?.folderIds;
  // Before its first catalog refresh only the folder itself is known.
  return Array.isArray(ids) && ids.length ? (ids as string[]) : [root.id];
}

function notionCandidate(root: LiveRoot, page: NotionPage, database: boolean): LiveCandidate {
  return {
    root,
    externalId: page.id,
    title: pageTitle(page),
    itemType: database ? "notion_database_page" : "notion_page",
    mimeType: null,
    url: page.url ?? null,
    modifiedAt: page.last_edited_time ?? null,
    revision: page.last_edited_time ?? "",
    path: [root.name],
  };
}

function toCatalog(c: LiveCandidate): ExternalItem {
  return {
    externalId: c.externalId,
    title: c.title,
    itemType: c.itemType,
    mimeType: c.mimeType,
    url: c.url,
    modifiedAt: c.modifiedAt,
    revision: c.revision,
    path: c.path,
  };
}

export function liveKnowledge(auth: AuthContext) {
  const notion = new Map<string, NotionClient>();
  const drive = new Map<string, GoogleDriveClient>();
  const notionFor = (id: string) => {
    if (!notion.has(id)) notion.set(id, notionClientFor(auth, id));
    return notion.get(id)!;
  };
  const driveFor = (id: string) => {
    if (!drive.has(id)) drive.set(id, new GoogleDriveClient(googleHttpFor(auth, id)));
    return drive.get(id)!;
  };

  /** Stage 3: what this root's provider says could answer. */
  async function candidates(
    root: LiveRoot,
    configuration: unknown,
    terms: string[],
    recent: boolean,
  ): Promise<LiveCandidate[]> {
    const limit = LIVE.candidatesPerRoot;
    if (root.sourceType === "notion") {
      const client = notionFor(root.connectionId);
      const remembered = async (key: string, read: () => Promise<string[]>) => {
        const k = `${root.connectionId}:${key}`;
        const hit = structureCache.get(k);
        if (hit) return hit;
        const value = await read();
        structureCache.set(k, value);
        return value;
      };
      const query = async (databaseId: string) =>
        client.findInDatabase(databaseId, {
          terms,
          recent,
          limit,
          dataSources: await remembered(`ds:${databaseId}`, () => client.dataSources(databaseId)),
        });
      if (root.kind === "database") {
        return (await query(root.id)).map((p) => notionCandidate(root, p, true));
      }
      // A page: the databases on it are queried live; its subpages come from the catalog.
      const databases = (
        await remembered(`children:${root.id}`, async () =>
          (await client.childDatabases(root.id)).map((d) => d.id),
        )
      ).slice(0, 2);
      const fromDatabases = (await Promise.all(databases.map((id) => query(id)))).flat();
      const { data: subpages } = await auth.db
        .from("knowledge_items")
        .select("external_id, title, source_url, external_modified_at, metadata")
        .eq("workspace_id", auth.workspaceId)
        .eq("source_id", root.sourceId)
        .eq("item_type", "notion_page")
        .neq("status", "removed")
        .limit(200);
      const named = (subpages ?? [])
        .filter((p) => termScore(p.title, terms) > 0)
        .sort((a, b) => termScore(b.title, terms) - termScore(a.title, terms))
        .map((p): LiveCandidate => ({
          root,
          externalId: p.external_id,
          title: p.title,
          itemType: "notion_page",
          mimeType: null,
          url: p.source_url,
          modifiedAt: p.external_modified_at,
          revision: (p.metadata as { revision?: string } | null)?.revision ?? "",
          path: [root.name],
        }));
      const own = databases.length
        ? []
        : [notionCandidate(root, await client.page(root.id), false)];
      return [...fromDatabases.map((p) => notionCandidate(root, p, true)), ...named, ...own].slice(
        0,
        limit,
      );
    }
    const client = driveFor(root.connectionId);
    if (root.kind === "file") {
      const file = await client.file(root.id);
      const item = file ? toExternalItem(file, []) : null;
      return item ? [{ root, ...item }] : [];
    }
    const files = await client.search({
      folderIds: folderScope(configuration, root),
      terms,
      recent,
      limit,
    });
    return files.flatMap((f) => {
      const item = toExternalItem(f, [root.name]);
      return item ? [{ root, ...item }] : [];
    });
  }

  /** Stage 4: the candidate's content, read now (or from the short cache of this revision). */
  async function read(c: LiveCandidate): Promise<NormalizedDocument> {
    const key = liveCacheKey(c);
    const cached = c.revision ? contentCache.get(key) : undefined;
    if (cached) return cached;
    let doc: NormalizedDocument;
    if (c.root.sourceType === "notion") {
      doc = await notionFor(c.root.connectionId).pageDocument(c.externalId, LIVE_PAGE_BLOCKS);
    } else {
      const content = await driveFor(c.root.connectionId).content(c.externalId, c.mimeType ?? "");
      doc = await readDocument(auth.workspaceId, { title: c.title, ...content }, undefined, "live");
    }
    contentCache.forget(`${c.root.sourceType}:${c.externalId}:`);
    if (c.revision) contentCache.set(key, doc);
    return doc;
  }

  return {
    async liveSearch(q: {
      text: string;
      spaceIds: string[] | null;
      recent: boolean;
    }): Promise<LiveSearchOutcome> {
      const started = Date.now();
      let query = auth.db
        .from("knowledge_sources")
        .select("id, space_id, source_type, connection_id, display_name, configuration, status")
        .eq("workspace_id", auth.workspaceId)
        .eq("access_mode", "external_live")
        .is("archived_at", null)
        .neq("status", "disconnected");
      if (q.spaceIds) query = query.in("space_id", q.spaceIds);
      const { data: sources } = await query;
      if (!sources?.length) return { hits: [], consulted: [], unavailable: [] };

      const terms = searchTerms(q.text);
      const { data: spaceRows } = await auth.db
        .from("knowledge_spaces")
        .select("id, name, parent_space_id, description")
        .eq("workspace_id", auth.workspaceId);
      const spaceName = new Map(
        spacePaths(
          (spaceRows ?? []).map((s) => ({ id: s.id, name: s.name, parentId: s.parent_space_id })),
        ).map((s) => [s.id, s.path]),
      );
      const config = new Map(sources.map((s) => [s.id, s.configuration]));
      const roots = sources.flatMap((s): LiveRoot[] =>
        s.connection_id && (s.source_type === "notion" || s.source_type === "google_drive")
          ? selectionOf(s.configuration).map((r) => ({
              sourceId: s.id,
              spaceId: s.space_id,
              sourceType: s.source_type as LiveRoot["sourceType"],
              connectionId: s.connection_id!,
              id: r.id,
              kind: r.kind,
              name: r.name,
            }))
          : [],
      );
      const chosen = rankRoots(roots, terms);
      // Stage 3 searches the subject, not the words that only say where to look.
      const scopeNames = [
        ...chosen.map((r) => r.name),
        ...(spaceRows ?? [])
          .filter((s) => chosen.some((r) => r.spaceId === s.id))
          .flatMap((s) => [s.name, s.description ?? ""]),
      ];
      const subject = subjectTerms(terms, scopeNames);
      // Nothing left to match ("¿qué hay en la Pipeline?"): the newest is the useful answer.
      const recent = q.recent || wantsRecent(q.text) || subject.length === 0;
      const unavailable: LiveSearchOutcome["unavailable"] = [];
      const fail = (name: string) => (error: unknown) => {
        unavailable.push({ name, code: toAppError(error).code });
        return null;
      };
      const perRoot = await Promise.all(
        chosen.map((r) =>
          candidates(r, config.get(r.sourceId), subject, recent).catch(fail(r.name)),
        ),
      );
      const picked = pickCandidates(perRoot.map((l) => l ?? []));
      const store = new SupabaseKnowledgeStore(createAdminClient());
      const [docs, itemIds] = await Promise.all([
        Promise.all(picked.map((c) => read(c).catch(fail(c.title)))),
        // Opportunistic catalog refresh: every citation points at a stable item.
        Promise.all(
          picked.map((c) =>
            store
              .ensureCatalogItem(
                {
                  id: c.root.sourceId,
                  workspaceId: auth.workspaceId,
                  spaceId: c.root.spaceId,
                  sourceType: c.root.sourceType,
                  connectionId: c.root.connectionId,
                  configuration: null,
                } satisfies SyncSource,
                toCatalog(c),
              )
              .catch(() => null),
          ),
        ),
      ]);
      const hits: KnowledgeHit[] = [];
      for (const [rank, c] of picked.entries()) {
        const doc = docs[rank];
        const itemId = itemIds[rank];
        if (!doc || !itemId) continue;
        selectPassages(doc, subject).forEach((p, i) =>
          hits.push({
            chunkId: `live:${itemId}:${i}`,
            itemId,
            versionId: "",
            versionNumber: 0,
            title: c.title,
            itemType: c.itemType,
            sourceType: c.root.sourceType,
            sourceUrl: c.url,
            spaceId: c.root.spaceId,
            spaceName: spaceName.get(c.root.spaceId) ?? "",
            headingPath: p.headingPath,
            page: p.page,
            content: p.content,
            similarity: null,
            // The provider chose it for this question: it is evidence, ranked in its order.
            keywordMatched: true,
            score: liveScore(rank, p.matched),
            live: { modifiedAt: c.modifiedAt, path: c.path },
          }),
        );
      }
      logger.info("knowledge.live_search", {
        workspace_id: auth.workspaceId,
        sources: sources.length,
        roots_asked: chosen.length,
        candidates: perRoot.reduce((n, l) => n + (l?.length ?? 0), 0),
        fetched: docs.filter(Boolean).length,
        recent,
        unavailable: unavailable.length,
        latency_ms: Date.now() - started,
      });
      return { hits, consulted: chosen.map((r) => r.name), unavailable };
    },
  };
}
