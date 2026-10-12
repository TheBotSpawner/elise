import type {
  FieldMapping,
  QueryPage,
  QueryPlan,
  RecordValue,
  SchemaProperty,
  StructuredProvider,
  StructuredRecord,
  StructuredSource,
} from "@/core/capabilities/structured";
import { AppError } from "@/core/errors";
import { TtlCache } from "@/core/knowledge/live";
import { makeExternalRef, parseExternalRef } from "@/core/providers/refs";
import {
  diffSchema,
  matchSourceNames,
  proposeMapping,
  schemaFingerprint,
} from "@/core/structured/mapping";
import { logger } from "@/infrastructure/observability/logger";
import type { Json, StructuredSourceRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import {
  compileFilters,
  compileSorts,
  dataSourceTitle,
  readRecord,
  toSchema,
  writeProperties,
  type NotionDataSource,
  type NotionRowPage,
  type NotionStructuredApi,
} from "./structured";

/** How long a checked schema is trusted before the next live check. */
const SCHEMA_TTL_MS = 10 * 60_000;
/** Bulk changes up to this size run right away (≈3 requests/second, Notion's limit). */
const INLINE_BULK = 25;

/**
 * Databases shared with ELISE but not mapped (ADR-048) are readable live: their names are
 * remembered per connection and their schemas per data source for a few minutes, so a turn
 * doesn't rediscover the workspace. Content is never cached here — records are always live.
 */
const sharedCache = new TtlCache<{ id: string; name: string; url: string | null }[]>(
  SCHEMA_TTL_MS,
  50,
);
const schemaCache = new TtlCache<NotionDataSource>(SCHEMA_TTL_MS, 200);

/** Where a source's records live, mapped or live. */
interface Target {
  dataSourceId: string;
  /** The record ref's scope: the mapping row id, or `live:<data source>`. */
  scopeId: string;
  name: string;
  fields: FieldMapping[];
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export type BulkStarter = (input: {
  sourceId: string;
  recordRefs: string[];
  change: { values?: Record<string, RecordValue>; archive?: boolean };
  actionId: string | null;
}) => Promise<void>;

/**
 * Structured Data from one Notion connection. Records are read and written live in Notion
 * (the source of truth); the mapping row says which property means what and what ELISE may
 * change. The schema is re-checked at most every 10 minutes: renames are followed, removed
 * or retyped fields are marked and the source needs attention.
 */
export class NotionStructuredProvider implements StructuredProvider {
  private cached?: Promise<StructuredSourceRow[]>;

  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly connectionId: string,
    private readonly account: string,
    private readonly api: NotionStructuredApi,
    private readonly startBulk: BulkStarter,
  ) {}

  private rows() {
    this.cached ??= (async () => {
      const { data, error } = await this.db
        .from("structured_sources")
        .select("*")
        .eq("workspace_id", this.workspaceId)
        .eq("connection_id", this.connectionId)
        .is("archived_at", null)
        .order("name");
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not load structured sources", { cause: error });
      return data ?? [];
    })();
    return this.cached;
  }

  private toSource(row: StructuredSourceRow): StructuredSource {
    return {
      id: makeExternalRef(this.connectionId, "source", row.id),
      name: row.name,
      context: row.context,
      providerKey: "notion",
      connectionId: this.connectionId,
      account: this.account,
      semanticType: row.semantic_type,
      fields: row.field_mappings as unknown as FieldMapping[],
      permissions: {
        read: row.allow_read,
        create: row.allow_create,
        update: row.allow_update,
        archive: row.allow_archive,
      },
      status: row.status === "archived" ? "paused" : row.status,
      schemaCheckedAt: row.schema_checked_at,
      url: row.url,
    };
  }

  private mappingId(source: StructuredSource): string {
    const ref = parseExternalRef(source.id);
    if (!ref || ref.connectionId !== this.connectionId || ref.parts[0] !== "source")
      throw new AppError("VALIDATION_ERROR", "That source belongs to another account", {
        recovery: "review",
      });
    return ref.parts[1]!;
  }

  async listSources() {
    const rows = await this.rows();
    const mapped = new Set(rows.map((r) => r.data_source_id));
    // Shared, unmapped databases are listed too (read-only; fields load when one is used).
    const live = (await this.shared().catch(() => []))
      .filter((s) => !mapped.has(s.id))
      .map((s) => this.liveSource({ id: s.id, name: s.name, url: s.url }, []));
    return [...rows.map((r) => this.toSource(r)), ...live];
  }

  /** The data sources shared with this connection (names only), remembered for a while. */
  private async shared() {
    const hit = sharedCache.get(this.connectionId);
    if (hit) return hit;
    const list = (await this.api.listDataSources()).map((ds) => ({
      id: ds.id,
      name: dataSourceTitle(ds).trim(),
      url: ds.url ?? null,
    }));
    sharedCache.set(this.connectionId, list);
    return list;
  }

  /** A data source's live schema; cached for a few minutes (`hit` says whether it was). */
  private async schema(dataSourceId: string): Promise<{ ds: NotionDataSource; hit: boolean }> {
    const key = `${this.connectionId}:${dataSourceId}`;
    const hit = schemaCache.get(key);
    if (hit) return { ds: hit, hit: true };
    const ds = await this.api.dataSource(dataSourceId);
    schemaCache.set(key, ds);
    return { ds, hit: false };
  }

  /**
   * An unmapped database as a read-only source: its fields mapped from the live schema by the
   * same rules a mapping proposes. Writing still needs a confirmed mapping (ADR-011).
   */
  private liveSource(
    ds: { id: string; name: string; url: string | null },
    fields: FieldMapping[],
  ): StructuredSource {
    return {
      id: makeExternalRef(this.connectionId, "live", ds.id),
      name: ds.name || "Untitled",
      context: null,
      providerKey: "notion",
      connectionId: this.connectionId,
      account: this.account,
      semanticType: "generic",
      fields,
      permissions: { read: true, create: false, update: false, archive: false },
      status: "active",
      schemaCheckedAt: fields.length ? new Date().toISOString() : null,
      url: ds.url,
    };
  }

  private async resolvedLive(dataSourceId: string) {
    const { ds, hit } = await this.schema(dataSourceId);
    logger.info("structured.live_source_resolved", {
      data_source_id: dataSourceId,
      schema_cache: hit ? "hit" : "miss",
    });
    return this.liveSource(
      { id: ds.id, name: dataSourceTitle(ds).trim(), url: ds.url ?? null },
      proposeMapping(toSchema(ds)),
    );
  }

  private target(source: StructuredSource, row?: StructuredSourceRow): Target {
    const ref = parseExternalRef(source.id);
    if (ref?.connectionId === this.connectionId && ref.parts[0] === "live")
      return {
        dataSourceId: ref.parts[1]!,
        scopeId: `live:${ref.parts[1]}`,
        name: source.name,
        fields: source.fields,
      };
    if (!row) throw new AppError("INTERNAL_ERROR", "Mapped source without its row");
    return {
      dataSourceId: row.data_source_id,
      scopeId: row.id,
      name: row.name,
      fields: row.field_mappings as unknown as FieldMapping[],
    };
  }

  private async targetOf(source: StructuredSource): Promise<Target> {
    const ref = parseExternalRef(source.id);
    return ref?.parts[0] === "live"
      ? this.target(source)
      : this.target(source, await this.sourceRow(source));
  }

  async findSources(ref: string) {
    const rows = await this.rows();
    const parsed = parseExternalRef(ref);
    if (parsed && parsed.parts[0] === "live")
      return parsed.connectionId === this.connectionId
        ? [await this.resolvedLive(parsed.parts[1]!)]
        : [];
    let matches: StructuredSourceRow[];
    if (parsed && parsed.parts[0] === "source") {
      matches =
        parsed.connectionId === this.connectionId
          ? rows.filter((r) => r.id === parsed.parts[1])
          : [];
    } else {
      const wanted = norm(ref);
      const exact = rows.filter((r) => norm(r.name) === wanted);
      matches = exact.length
        ? exact
        : rows.filter(
            (r) =>
              norm(r.name).includes(wanted) ||
              wanted.includes(norm(r.name)) ||
              (r.context ?? "")
                .split(/[,;]+/)
                .map(norm)
                .some((c) => c.length >= 3 && (wanted.includes(c) || c === wanted)),
          );
    }
    if (matches.length || parsed)
      return Promise.all(matches.map(async (r) => this.toSource(await this.fresh(r))));
    // Not mapped: the databases shared with ELISE, by name, deterministically (ADR-048).
    const mapped = new Set(rows.map((r) => r.data_source_id));
    const found = matchSourceNames(
      ref,
      (await this.shared()).filter((s) => !mapped.has(s.id)),
    ).slice(0, 5);
    return Promise.all(found.map((s) => this.resolvedLive(s.id)));
  }

  /** Re-checks the live schema when stale; saves renames, broken fields and status. */
  private async fresh(row: StructuredSourceRow): Promise<StructuredSourceRow> {
    const checked = row.schema_checked_at ? Date.parse(row.schema_checked_at) : 0;
    if (Date.now() - checked < SCHEMA_TTL_MS) return row;
    const ds = await this.api.dataSource(row.data_source_id);
    const updated = applySchema(row, toSchema(ds));
    await this.db
      .from("structured_sources")
      .update({
        field_mappings: updated.field_mappings,
        schema_snapshot: updated.schema_snapshot,
        schema_fingerprint: updated.schema_fingerprint,
        schema_issues: updated.schema_issues,
        status: updated.status,
        schema_checked_at: updated.schema_checked_at,
      })
      .eq("id", row.id)
      .eq("workspace_id", this.workspaceId);
    this.cached = undefined;
    return updated;
  }

  private async sourceRow(source: StructuredSource) {
    const row = (await this.rows()).find((r) => r.id === this.mappingId(source));
    if (!row)
      throw new AppError("NOT_FOUND", "That source is no longer mapped", { recovery: "review" });
    return row;
  }

  private toRecord(page: NotionRowPage, t: Target): StructuredRecord {
    const { title, values } = readRecord(page, t.fields);
    const live = t.scopeId.startsWith("live:");
    return {
      id: makeExternalRef(this.connectionId, "record", t.scopeId, page.id),
      sourceId: live
        ? makeExternalRef(this.connectionId, "live", t.dataSourceId)
        : makeExternalRef(this.connectionId, "source", t.scopeId),
      title,
      values,
      url: page.url ?? null,
      updatedAt: page.last_edited_time ?? null,
      provenance: {
        providerKey: "notion",
        connectionId: this.connectionId,
        source: t.name,
        account: this.account,
      },
    };
  }

  private body(source: StructuredSource, plan: Omit<QueryPlan, "limit" | "cursor">) {
    const titleField = source.fields.find((f) => f.isTitle && !f.broken);
    const filter = compileFilters(
      plan.filters,
      plan.search && titleField ? { titleId: titleField.propertyId, text: plan.search } : undefined,
    );
    return {
      ...(filter ? { filter } : {}),
      ...(plan.sort.length ? { sorts: compileSorts(plan.sort) } : {}),
    };
  }

  async query(source: StructuredSource, plan: QueryPlan): Promise<QueryPage> {
    const t = await this.targetOf(source);
    const res = await this.api.query(t.dataSourceId, {
      ...this.body(source, plan),
      page_size: Math.min(Math.max(plan.limit, 1), 100),
      ...(plan.cursor ? { start_cursor: plan.cursor } : {}),
    });
    return {
      records: res.results.filter((p) => !p.in_trash).map((p) => this.toRecord(p, t)),
      hasMore: res.has_more,
      nextCursor: res.next_cursor,
    };
  }

  /** Batches of 100 through the provider's pagination, bounded; logged for diagnosis. */
  async readAll(source: StructuredSource, plan: Omit<QueryPlan, "limit" | "cursor">, max: number) {
    const t = await this.targetOf(source);
    const before = { ...this.api.stats };
    const records: StructuredRecord[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let more = true;
    while (more && records.length < max) {
      const res = await this.api.query(t.dataSourceId, {
        ...this.body(source, plan),
        page_size: Math.min(100, max - records.length),
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      pages++;
      records.push(...res.results.filter((p) => !p.in_trash).map((p) => this.toRecord(p, t)));
      cursor = res.next_cursor ?? undefined;
      more = res.has_more && Boolean(cursor);
    }
    const s = this.api.stats;
    logger.info("structured.read_all", {
      data_source_id: t.dataSourceId,
      live: t.scopeId.startsWith("live:"),
      pages,
      records: records.length,
      complete: !more,
      requests: s.requests - before.requests,
      shared_requests: s.shared - before.shared,
      retries: s.retries - before.retries,
      rate_limited: s.rateLimited - before.rateLimited,
    });
    return { records, complete: !more };
  }

  private pageOf(ref: string): { scopeId: string; pageId: string } | null {
    const parsed = parseExternalRef(ref);
    if (!parsed || parsed.connectionId !== this.connectionId || parsed.parts[0] !== "record")
      return null;
    return { scopeId: parsed.parts[1]!, pageId: parsed.parts[2]! };
  }

  /** A page is only this source's record if its parent is the source's data source. */
  private async ownPage(ref: string) {
    const target = this.pageOf(ref);
    if (!target) return null;
    let t: Target;
    if (target.scopeId.startsWith("live:")) {
      t = this.target(await this.resolvedLive(target.scopeId.slice(5)));
    } else {
      const row = (await this.rows()).find((r) => r.id === target.scopeId);
      if (!row) return null;
      t = this.target(this.toSource(row), row);
    }
    const page = await this.api.page(target.pageId);
    if (page.in_trash || page.parent?.data_source_id !== t.dataSourceId) return null;
    return { page, t };
  }

  async getRecord(ref: string) {
    const own = await this.ownPage(ref);
    return own ? this.toRecord(own.page, own.t) : null;
  }

  async createRecord(source: StructuredSource, values: Record<string, RecordValue>) {
    const row = await this.sourceRow(source);
    const page = await this.api.createPage(
      row.data_source_id,
      writeProperties(values, source.fields),
    );
    return this.toRecord(page, this.target(source, row));
  }

  async updateRecord(
    source: StructuredSource,
    recordRef: string,
    values: Record<string, RecordValue>,
  ) {
    const own = await this.ownPage(recordRef);
    if (!own || own.t.scopeId !== this.mappingId(source))
      throw new AppError("NOT_FOUND", "That record isn't in this source anymore", {
        recovery: "review",
      });
    const page = await this.api.updatePage(own.page.id, {
      properties: writeProperties(values, source.fields),
    });
    return this.toRecord(page, own.t);
  }

  async archiveRecord(source: StructuredSource, recordRef: string) {
    const own = await this.ownPage(recordRef);
    if (!own || own.t.scopeId !== this.mappingId(source))
      throw new AppError("NOT_FOUND", "That record isn't in this source anymore", {
        recovery: "review",
      });
    const page = await this.api.updatePage(own.page.id, { in_trash: true });
    return this.toRecord(page, own.t);
  }

  async bulkUpdate(
    source: StructuredSource,
    recordRefs: string[],
    change: { values?: Record<string, RecordValue>; archive?: boolean },
    actionId: string | null,
  ) {
    if (recordRefs.length > INLINE_BULK) {
      await this.startBulk({ sourceId: source.id, recordRefs, change, actionId });
      return { done: 0, queued: recordRefs.length };
    }
    let done = 0;
    for (const ref of recordRefs) {
      if (change.archive) await this.archiveRecord(source, ref);
      else await this.updateRecord(source, ref, change.values ?? {});
      done++;
      await new Promise((r) => setTimeout(r, 350));
    }
    return { done, queued: 0 };
  }
}

/** A live schema applied to a saved mapping (pure, so it is tested without Notion). */
export function applySchema(
  row: StructuredSourceRow,
  current: SchemaProperty[],
): StructuredSourceRow {
  const change = diffSchema(row.field_mappings as unknown as FieldMapping[], current);
  const broken = change.removed.length + change.typeChanged.length > 0;
  return {
    ...row,
    field_mappings: change.fields as unknown as Json,
    schema_snapshot: current as unknown as Json,
    schema_fingerprint: schemaFingerprint(current),
    schema_issues: {
      renamed: change.renamed,
      removed: change.removed,
      typeChanged: change.typeChanged,
      added: change.added.map((p) => p.name),
      titleBroken: change.titleBroken,
    } as unknown as Json,
    // Paused sources stay paused; a broken field needs the user's attention.
    status: row.status === "paused" ? "paused" : broken ? "needs_attention" : "active",
    schema_checked_at: new Date().toISOString(),
  };
}
