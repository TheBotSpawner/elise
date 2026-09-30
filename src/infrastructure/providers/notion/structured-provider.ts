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
import { makeExternalRef, parseExternalRef } from "@/core/providers/refs";
import { diffSchema, schemaFingerprint } from "@/core/structured/mapping";
import type { Json, StructuredSourceRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import {
  compileFilters,
  compileSorts,
  readRecord,
  toSchema,
  writeProperties,
  type NotionRowPage,
  type NotionStructuredApi,
} from "./structured";

/** How long a checked schema is trusted before the next live check. */
const SCHEMA_TTL_MS = 10 * 60_000;
/** Bulk changes up to this size run right away (≈3 requests/second, Notion's limit). */
const INLINE_BULK = 25;

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
    return (await this.rows()).map((r) => this.toSource(r));
  }

  async findSources(ref: string) {
    const rows = await this.rows();
    const parsed = parseExternalRef(ref);
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
    return Promise.all(matches.map(async (r) => this.toSource(await this.fresh(r))));
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

  private toRecord(page: NotionRowPage, row: StructuredSourceRow): StructuredRecord {
    const fields = row.field_mappings as unknown as FieldMapping[];
    const { title, values } = readRecord(page, fields);
    return {
      id: makeExternalRef(this.connectionId, "record", row.id, page.id),
      sourceId: makeExternalRef(this.connectionId, "source", row.id),
      title,
      values,
      url: page.url ?? null,
      updatedAt: page.last_edited_time ?? null,
      provenance: {
        providerKey: "notion",
        connectionId: this.connectionId,
        source: row.name,
        account: this.account,
      },
    };
  }

  async query(source: StructuredSource, plan: QueryPlan): Promise<QueryPage> {
    const row = await this.sourceRow(source);
    const titleField = source.fields.find((f) => f.isTitle && !f.broken);
    const filter = compileFilters(
      plan.filters,
      plan.search && titleField ? { titleId: titleField.propertyId, text: plan.search } : undefined,
    );
    const res = await this.api.query(row.data_source_id, {
      ...(filter ? { filter } : {}),
      ...(plan.sort.length ? { sorts: compileSorts(plan.sort) } : {}),
      page_size: Math.min(Math.max(plan.limit, 1), 100),
      ...(plan.cursor ? { start_cursor: plan.cursor } : {}),
    });
    return {
      records: res.results.filter((p) => !p.in_trash).map((p) => this.toRecord(p, row)),
      hasMore: res.has_more,
      nextCursor: res.next_cursor,
    };
  }

  private pageOf(ref: string): { mappingId: string; pageId: string } | null {
    const parsed = parseExternalRef(ref);
    if (!parsed || parsed.connectionId !== this.connectionId || parsed.parts[0] !== "record")
      return null;
    return { mappingId: parsed.parts[1]!, pageId: parsed.parts[2]! };
  }

  /** A page is only this source's record if its parent is the mapped data source. */
  private async ownPage(ref: string) {
    const target = this.pageOf(ref);
    if (!target) return null;
    const row = (await this.rows()).find((r) => r.id === target.mappingId);
    if (!row) return null;
    const page = await this.api.page(target.pageId);
    if (page.in_trash || page.parent?.data_source_id !== row.data_source_id) return null;
    return { page, row };
  }

  async getRecord(ref: string) {
    const own = await this.ownPage(ref);
    return own ? this.toRecord(own.page, own.row) : null;
  }

  async createRecord(source: StructuredSource, values: Record<string, RecordValue>) {
    const row = await this.sourceRow(source);
    const page = await this.api.createPage(
      row.data_source_id,
      writeProperties(values, source.fields),
    );
    return this.toRecord(page, row);
  }

  async updateRecord(
    source: StructuredSource,
    recordRef: string,
    values: Record<string, RecordValue>,
  ) {
    const own = await this.ownPage(recordRef);
    if (!own || own.row.id !== this.mappingId(source))
      throw new AppError("NOT_FOUND", "That record isn't in this source anymore", {
        recovery: "review",
      });
    const page = await this.api.updatePage(own.page.id, {
      properties: writeProperties(values, source.fields),
    });
    return this.toRecord(page, own.row);
  }

  async archiveRecord(source: StructuredSource, recordRef: string) {
    const own = await this.ownPage(recordRef);
    if (!own || own.row.id !== this.mappingId(source))
      throw new AppError("NOT_FOUND", "That record isn't in this source anymore", {
        recovery: "review",
      });
    const page = await this.api.updatePage(own.page.id, { in_trash: true });
    return this.toRecord(page, own.row);
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
