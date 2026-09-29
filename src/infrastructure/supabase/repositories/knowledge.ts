import type { SupabaseClient } from "@supabase/supabase-js";

import { AppError } from "@/core/errors";
import {
  spacePaths,
  type ChangeEntry,
  type EmbeddingProvider,
  type ItemDetail,
  type KnowledgeHit,
  type KnowledgeReader,
  type KnowledgeSourceType,
  type SourceInfo,
  type SpaceInfo,
  type VersionText,
} from "@/core/knowledge/model";
import { keywordQuery } from "@/core/knowledge/retrieval";
import { logger } from "@/infrastructure/observability/logger";

import type { Database } from "../database.types";

type Db = SupabaseClient<Database>;

/** pgvector literal for PostgREST. */
export const toVector = (v: number[]) => `[${v.join(",")}]`;

/**
 * Knowledge reads for one workspace. Every query filters by workspace_id explicitly; with the
 * user's session RLS applies as well. The search RPC scopes before it ranks.
 */
export class SupabaseKnowledgeReader implements KnowledgeReader {
  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly embeddings: () => EmbeddingProvider,
  ) {}

  async spaces(): Promise<SpaceInfo[]> {
    const { data, error } = await this.db
      .from("knowledge_spaces")
      .select("id, name, parent_space_id")
      .eq("workspace_id", this.workspaceId)
      .eq("status", "active")
      .order("name");
    if (error) throw new AppError("INTERNAL_ERROR", "Could not load Spaces", { cause: error });
    return spacePaths(data.map((s) => ({ id: s.id, name: s.name, parentId: s.parent_space_id })));
  }

  async search(q: {
    text: string;
    spaceIds: string[] | null;
    itemIds: string[] | null;
    limit: number;
  }): Promise<{ hits: KnowledgeHit[]; semantic: boolean }> {
    const started = Date.now();
    let embedding: string | null = null;
    let model = "";
    try {
      const provider = this.embeddings();
      model = provider.model;
      embedding = toVector((await provider.embed([q.text]))[0]!);
    } catch (error) {
      // Keyword search still works without embeddings; say so in the result.
      logger.warn("knowledge.search_semantic_unavailable", {
        code: error instanceof AppError ? error.code : "UNKNOWN",
      });
    }
    const { data, error } = await this.db.rpc("search_knowledge_chunks", {
      p_workspace_id: this.workspaceId,
      p_keywords: keywordQuery(q.text),
      p_embedding: embedding,
      p_embedding_model: model,
      p_space_ids: q.spaceIds,
      p_item_ids: q.itemIds,
      p_limit: q.limit,
    });
    if (error) throw new AppError("INTERNAL_ERROR", "Knowledge search failed", { cause: error });

    const itemIds = [...new Set(data.map((r) => r.knowledge_item_id))];
    const versionIds = [...new Set(data.map((r) => r.version_id))];
    const [items, versions, spaces] = await Promise.all([
      itemIds.length
        ? this.db
            .from("knowledge_items")
            .select("id, title, item_type, source_url, source_id, knowledge_sources(source_type)")
            .eq("workspace_id", this.workspaceId)
            .in("id", itemIds)
        : { data: [] },
      versionIds.length
        ? this.db
            .from("knowledge_versions")
            .select("id, version_number")
            .eq("workspace_id", this.workspaceId)
            .in("id", versionIds)
        : { data: [] },
      this.spaces(),
    ]);
    const itemById = new Map((items.data ?? []).map((i) => [i.id, i]));
    const versionById = new Map((versions.data ?? []).map((v) => [v.id, v.version_number]));
    const spaceById = new Map(spaces.map((s) => [s.id, s]));

    const hits = data.flatMap((r): KnowledgeHit[] => {
      const item = itemById.get(r.knowledge_item_id);
      if (!item) return [];
      const source = item.knowledge_sources as unknown as {
        source_type: KnowledgeSourceType;
      } | null;
      return [
        {
          chunkId: r.chunk_id,
          itemId: r.knowledge_item_id,
          versionId: r.version_id,
          versionNumber: versionById.get(r.version_id) ?? 1,
          title: item.title,
          itemType: item.item_type,
          sourceType: source?.source_type ?? "upload",
          sourceUrl: item.source_url,
          spaceId: r.space_id,
          spaceName: spaceById.get(r.space_id)?.path ?? "",
          headingPath: r.heading_path ?? [],
          page: r.page_number,
          content: r.content,
          similarity: r.similarity,
          keywordMatched: r.keyword_rank !== null,
          score: r.score,
        },
      ];
    });
    logger.info("knowledge.search", {
      workspace_id: this.workspaceId,
      scoped_spaces: q.spaceIds?.length ?? "all",
      results: hits.length,
      semantic: embedding !== null,
      latency_ms: Date.now() - started,
    });
    return { hits, semantic: embedding !== null };
  }

  async getItem(itemId: string): Promise<ItemDetail | null> {
    const { data } = await this.db
      .from("knowledge_items")
      .select(
        "id, title, item_type, status, source_url, space_id, updated_at, knowledge_sources(source_type), knowledge_spaces(name), knowledge_versions!knowledge_versions_knowledge_item_id_fkey(id, version_number, created_at, is_current, status)",
      )
      .eq("id", itemId)
      .eq("workspace_id", this.workspaceId)
      .maybeSingle();
    if (!data) return null;
    const source = data.knowledge_sources as unknown as { source_type: KnowledgeSourceType } | null;
    const space = data.knowledge_spaces as unknown as { name: string } | null;
    const versions = (data.knowledge_versions ?? []) as unknown as {
      id: string;
      version_number: number;
      created_at: string;
      is_current: boolean;
      status: string;
    }[];
    return {
      id: data.id,
      title: data.title,
      itemType: data.item_type,
      sourceType: source?.source_type ?? "upload",
      status: data.status,
      sourceUrl: data.source_url,
      spaceId: data.space_id,
      spaceName: space?.name ?? "",
      updatedAt: data.updated_at,
      versions: versions
        .sort((a, b) => b.version_number - a.version_number)
        .map((v) => ({
          id: v.id,
          number: v.version_number,
          createdAt: v.created_at,
          isCurrent: v.is_current,
          status: v.status,
        })),
    };
  }

  async listSources(spaceIds: string[] | null): Promise<SourceInfo[]> {
    let query = this.db
      .from("knowledge_sources")
      .select("id, space_id, source_type, display_name, status, last_synced_at")
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null);
    if (spaceIds) query = query.in("space_id", spaceIds);
    const [{ data: sources }, { data: items }, spaces] = await Promise.all([
      query,
      this.db
        .from("knowledge_items")
        .select("source_id, status")
        .eq("workspace_id", this.workspaceId)
        .is("archived_at", null),
      this.spaces(),
    ]);
    const spaceName = new Map(spaces.map((s) => [s.id, s.path]));
    return (sources ?? []).map((s) => {
      const own = (items ?? []).filter((i) => i.source_id === s.id);
      return {
        id: s.id,
        spaceId: s.space_id,
        spaceName: spaceName.get(s.space_id) ?? "",
        sourceType: s.source_type,
        name: s.display_name,
        status: s.status,
        lastSyncedAt: s.last_synced_at,
        items: {
          ready: own.filter((i) => i.status === "ready").length,
          processing: own.filter((i) => i.status === "queued" || i.status === "processing").length,
          failed: own.filter((i) => i.status === "failed" || i.status === "needs_attention").length,
        },
      };
    });
  }

  async recentChanges(spaceIds: string[] | null, since: Date): Promise<ChangeEntry[]> {
    const versions = this.db
      .from("knowledge_versions")
      .select(
        "version_number, created_at, status, knowledge_items!knowledge_versions_knowledge_item_id_fkey(id, title, space_id, knowledge_sources(source_type))",
      )
      .eq("workspace_id", this.workspaceId)
      .gte("created_at", since.toISOString())
      .in("status", ["ready", "processing", "pending"])
      .order("created_at", { ascending: false })
      .limit(60);
    let removed = this.db
      .from("knowledge_items")
      .select("id, title, space_id, updated_at, knowledge_sources(source_type)")
      .eq("workspace_id", this.workspaceId)
      .eq("status", "removed")
      .gte("updated_at", since.toISOString())
      .limit(30);
    if (spaceIds) removed = removed.in("space_id", spaceIds);
    const [{ data: v }, { data: r }, spaces] = await Promise.all([
      versions,
      removed,
      this.spaces(),
    ]);
    const spaceName = new Map(spaces.map((s) => [s.id, s.path]));
    type ItemRef = {
      id: string;
      title: string;
      space_id: string;
      knowledge_sources: { source_type: KnowledgeSourceType } | null;
    };
    const out: ChangeEntry[] = [];
    for (const row of v ?? []) {
      const item = row.knowledge_items as unknown as ItemRef | null;
      if (!item || (spaceIds && !spaceIds.includes(item.space_id))) continue;
      out.push({
        itemId: item.id,
        title: item.title,
        spaceName: spaceName.get(item.space_id) ?? "",
        sourceType: item.knowledge_sources?.source_type ?? "upload",
        change: row.version_number === 1 ? "added" : "updated",
        versionNumber: row.version_number,
        at: row.created_at,
      });
    }
    for (const item of (r ?? []) as unknown as (ItemRef & { updated_at: string })[]) {
      out.push({
        itemId: item.id,
        title: item.title,
        spaceName: spaceName.get(item.space_id) ?? "",
        sourceType: item.knowledge_sources?.source_type ?? "upload",
        change: "removed",
        versionNumber: null,
        at: item.updated_at,
      });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  async versionText(itemId: string, versionNumber: number | null): Promise<VersionText | null> {
    let query = this.db
      .from("knowledge_versions")
      .select(
        "id, version_number, created_at, extracted_text, knowledge_item_id, knowledge_items!knowledge_versions_knowledge_item_id_fkey(title)",
      )
      .eq("workspace_id", this.workspaceId)
      .eq("knowledge_item_id", itemId)
      .not("extracted_text", "is", null);
    query =
      versionNumber === null
        ? query.eq("is_current", true)
        : query.eq("version_number", versionNumber);
    const { data } = await query.limit(1).maybeSingle();
    if (!data?.extracted_text) return null;
    const item = data.knowledge_items as unknown as { title: string } | null;
    return {
      itemId: data.knowledge_item_id,
      versionId: data.id,
      versionNumber: data.version_number,
      title: item?.title ?? "",
      createdAt: data.created_at,
      text: data.extracted_text,
    };
  }

  async overview(spaceIds: string[] | null, limit: number) {
    let items = this.db
      .from("knowledge_items")
      .select("id, title, current_version_id", { count: "exact" })
      .eq("workspace_id", this.workspaceId)
      .eq("status", "ready")
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (spaceIds) items = items.in("space_id", spaceIds);
    const { data, count } = await items;
    const versionIds = (data ?? [])
      .map((i) => i.current_version_id)
      .filter((id): id is string => Boolean(id));
    const { data: firsts } = versionIds.length
      ? await this.db
          .from("knowledge_chunks")
          .select("version_id, content")
          .eq("workspace_id", this.workspaceId)
          .in("version_id", versionIds)
          .eq("chunk_index", 0)
      : { data: [] };
    const preview = new Map((firsts ?? []).map((c) => [c.version_id, c.content]));
    return {
      total: count ?? data?.length ?? 0,
      items: (data ?? []).map((i) => ({
        itemId: i.id,
        title: i.title,
        preview: (i.current_version_id && preview.get(i.current_version_id)) || "",
      })),
    };
  }
}
