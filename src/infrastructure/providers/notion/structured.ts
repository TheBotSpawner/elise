import type {
  FieldMapping,
  FieldType,
  RecordValue,
  ResolvedFilter,
  SchemaProperty,
  StatusGroup,
} from "@/core/capabilities/structured";
import { AppError } from "@/core/errors";

import type { NotionHttp } from "./http";

/**
 * Notion databases as structured data (API 2026-03-11): a database holds data sources; a data
 * source has the property schema and the rows (pages). Everything Notion-specific — property
 * types, filter JSON, property values — is translated here, so the rest of ELISE only sees
 * canonical fields. Filters and writes address properties by id, which survives renames.
 */

type NotionRich = { plain_text?: string }[];

export interface NotionProperty {
  id: string;
  name: string;
  type: string;
  [config: string]: unknown;
}

export interface NotionDataSource {
  object: "data_source";
  id: string;
  title?: NotionRich;
  url?: string;
  in_trash?: boolean;
  parent?: { type: string; database_id?: string };
  properties: Record<string, NotionProperty>;
}

export interface NotionRowPage {
  object: "page";
  id: string;
  url?: string;
  last_edited_time?: string;
  in_trash?: boolean;
  is_archived?: boolean;
  parent?: { type: string; data_source_id?: string; database_id?: string };
  properties: Record<string, { id: string; type: string; [value: string]: unknown }>;
}

const plain = (rich: unknown) =>
  Array.isArray(rich) ? (rich as NotionRich).map((r) => r.plain_text ?? "").join("") : "";

export const dataSourceTitle = (ds: { title?: NotionRich }) => plain(ds.title) || "Untitled";

// ── Schema ───────────────────────────────────────────────────────────────────

const TYPES: Record<string, FieldType> = {
  title: "text",
  rich_text: "text",
  number: "number",
  select: "select",
  multi_select: "multi_select",
  status: "status",
  checkbox: "checkbox",
  date: "date",
  url: "url",
  email: "email",
  phone_number: "phone",
  people: "people",
  relation: "relation",
  files: "files",
  // Set by Notion: readable, filterable as dates, never written.
  created_time: "date",
  last_edited_time: "date",
  formula: "computed",
  rollup: "computed",
  created_by: "computed",
  last_edited_by: "computed",
  unique_id: "computed",
  verification: "computed",
  button: "computed",
};
const READ_ONLY = new Set([
  "created_time",
  "last_edited_time",
  "formula",
  "rollup",
  "created_by",
  "last_edited_by",
  "unique_id",
  "verification",
  "button",
]);

function statusGroup(name: string): StatusGroup | null {
  const n = name.toLowerCase();
  if (/complete|done|hecho|complet/.test(n)) return "complete";
  if (/progress|curso|doing/.test(n)) return "in_progress";
  if (/to.?do|pendiente|not started|backlog/.test(n)) return "todo";
  return null;
}

/** A data source's properties as canonical schema properties. */
export function toSchema(ds: NotionDataSource): SchemaProperty[] {
  return Object.values(ds.properties).map((p) => {
    const type = TYPES[p.type] ?? "unsupported";
    let options: SchemaProperty["options"];
    if (p.type === "select" || p.type === "multi_select") {
      options = ((p[p.type] as { options?: { name: string }[] })?.options ?? []).map((o) => ({
        name: o.name,
      }));
    } else if (p.type === "status") {
      const cfg = p.status as {
        options?: { id: string; name: string }[];
        groups?: { name: string; option_ids?: string[] }[];
      };
      const groupOf = new Map<string, StatusGroup | null>();
      for (const g of cfg?.groups ?? [])
        for (const id of g.option_ids ?? []) groupOf.set(id, statusGroup(g.name));
      options = (cfg?.options ?? []).map((o) => ({
        name: o.name,
        group: groupOf.get(o.id) ?? null,
      }));
    }
    return {
      id: p.id,
      name: p.name,
      type,
      providerType: p.type,
      ...(options ? { options } : {}),
      readOnly: READ_ONLY.has(p.type) || type === "unsupported",
      isTitle: p.type === "title",
    };
  });
}

// ── Filters and sorts ────────────────────────────────────────────────────────

type NotionFilter = Record<string, unknown>;

function unsupported(f: ResolvedFilter): AppError {
  return new AppError("VALIDATION_ERROR", `ELISE can't filter ${f.field.label} that way`, {
    recovery: "review",
  });
}

function one(f: ResolvedFilter, op: string, value: unknown): NotionFilter {
  const t = f.field.providerType;
  if (t === "created_time" || t === "last_edited_time")
    return { timestamp: t, [t]: { [op]: value } };
  return { property: f.field.propertyId, [t]: { [op]: value } };
}

/** Canonical filters (already resolved by Core) → one Notion filter, AND-ed. */
export function compileFilters(
  filters: ResolvedFilter[],
  search?: { titleId: string; text: string },
): NotionFilter | undefined {
  const parts: NotionFilter[] = filters.map((f) => compileOne(f));
  if (search) parts.push({ property: search.titleId, title: { contains: search.text } });
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : { and: parts };
}

function compileOne(f: ResolvedFilter): NotionFilter {
  const t = f.field.providerType;
  if (f.op === "is_empty" || f.op === "is_not_empty") return one(f, f.op, true);
  const list = (Array.isArray(f.value) ? f.value : [f.value]) as unknown[];
  switch (t) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number": {
      const ops: Record<string, string> = {
        equals: "equals",
        not_equals: "does_not_equal",
        contains: "contains",
        not_contains: "does_not_contain",
      };
      if (f.op === "any_of") return { or: list.map((v) => one(f, "equals", v)) };
      if (!ops[f.op]) throw unsupported(f);
      return one(f, ops[f.op]!, f.value);
    }
    case "number": {
      const ops: Record<string, string> = {
        equals: "equals",
        not_equals: "does_not_equal",
        gt: "greater_than",
        gte: "greater_than_or_equal_to",
        lt: "less_than",
        lte: "less_than_or_equal_to",
      };
      if (!ops[f.op]) throw unsupported(f);
      return one(f, ops[f.op]!, f.value);
    }
    case "select":
    case "status":
      if (f.op === "equals") return one(f, "equals", f.value);
      if (f.op === "not_equals") return one(f, "does_not_equal", f.value);
      if (f.op === "any_of")
        return list.length === 1
          ? one(f, "equals", list[0])
          : { or: list.map((v) => one(f, "equals", v)) };
      if (f.op === "none_of")
        return list.length === 1
          ? one(f, "does_not_equal", list[0])
          : { and: list.map((v) => one(f, "does_not_equal", v)) };
      throw unsupported(f);
    case "multi_select":
      if (f.op === "contains" || f.op === "equals") return one(f, "contains", f.value);
      if (f.op === "not_contains" || f.op === "not_equals")
        return one(f, "does_not_contain", f.value);
      if (f.op === "any_of") return { or: list.map((v) => one(f, "contains", v)) };
      if (f.op === "none_of") return { and: list.map((v) => one(f, "does_not_contain", v)) };
      throw unsupported(f);
    case "checkbox":
      if (f.op === "equals") return one(f, "equals", f.value === true);
      if (f.op === "not_equals") return one(f, "does_not_equal", f.value === true);
      throw unsupported(f);
    case "date":
    case "created_time":
    case "last_edited_time":
      if (f.op === "equals" || f.op === "on_or_after" || f.op === "on_or_before")
        return one(f, f.op, f.value);
      if (f.op === "not_equals")
        return { or: [one(f, "before", f.value), one(f, "after", f.value)] };
      throw unsupported(f);
    default:
      throw unsupported(f);
  }
}

export function compileSorts(
  sort: { field: FieldMapping | "last_edited"; direction: "asc" | "desc" }[],
) {
  return sort.map((s) => {
    const direction = s.direction === "asc" ? "ascending" : "descending";
    if (s.field === "last_edited") return { timestamp: "last_edited_time", direction };
    const t = s.field.providerType;
    if (t === "created_time" || t === "last_edited_time") return { timestamp: t, direction };
    return { property: s.field.propertyId, direction };
  });
}

// ── Values ───────────────────────────────────────────────────────────────────

function readValue(p: { type: string; [value: string]: unknown }): RecordValue {
  const v = p[p.type];
  switch (p.type) {
    case "title":
    case "rich_text":
      return plain(v);
    case "number":
      return typeof v === "number" ? v : null;
    case "select":
    case "status":
      return (v as { name?: string } | null)?.name ?? null;
    case "multi_select":
      return ((v as { name: string }[]) ?? []).map((o) => o.name);
    case "checkbox":
      return Boolean(v);
    case "date": {
      const d = v as { start?: string; end?: string | null } | null;
      return d?.start ? (d.end ? { start: d.start, end: d.end } : { start: d.start }) : null;
    }
    case "url":
    case "email":
    case "phone_number":
      return typeof v === "string" ? v : null;
    case "people":
      return ((v as { name?: string; id: string }[]) ?? []).map((u) => u.name ?? "Someone");
    case "created_by":
    case "last_edited_by":
      return (v as { name?: string } | null)?.name ?? null;
    case "relation": {
      const n = ((v as unknown[]) ?? []).length;
      return n ? `${n} linked` : null;
    }
    case "files":
      return ((v as { name?: string }[]) ?? []).map((f) => f.name ?? "file");
    case "created_time":
    case "last_edited_time":
      return typeof v === "string" ? v : null;
    case "formula": {
      const f = v as { type?: string; [k: string]: unknown } | null;
      const out = f?.type ? f[f.type] : null;
      if (out && typeof out === "object" && "start" in (out as object))
        return { start: (out as { start: string }).start };
      return typeof out === "string" || typeof out === "number" || typeof out === "boolean"
        ? out
        : null;
    }
    case "rollup": {
      const r = v as {
        type?: string;
        number?: number;
        date?: { start?: string };
        array?: unknown[];
      } | null;
      if (r?.type === "number") return r.number ?? null;
      if (r?.type === "date") return r.date?.start ? { start: r.date.start } : null;
      if (r?.type === "array") return `${r.array?.length ?? 0} items`;
      return null;
    }
    case "unique_id": {
      const u = v as { prefix?: string | null; number?: number } | null;
      return u?.number !== undefined ? `${u.prefix ? `${u.prefix}-` : ""}${u.number}` : null;
    }
    case "verification":
      return (v as { state?: string } | null)?.state ?? null;
    default:
      return null;
  }
}

/** A row page → values by field key (only mapped, intact fields), plus its title. */
export function readRecord(page: NotionRowPage, fields: FieldMapping[]) {
  const byId = new Map(Object.values(page.properties).map((p) => [p.id, p]));
  const values: Record<string, RecordValue> = {};
  let title = "";
  for (const f of fields) {
    if (f.broken) continue;
    const p = byId.get(f.propertyId);
    if (!p) continue;
    const value = readValue(p);
    values[f.key] = value;
    if (f.isTitle) title = typeof value === "string" ? value : "";
  }
  return { title: title || "Untitled", values };
}

/** Validated canonical values → Notion property values, keyed by property id. */
export function writeProperties(values: Record<string, RecordValue>, fields: FieldMapping[]) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const f = fields.find((x) => x.key === key);
    if (!f || !f.writable || f.broken)
      throw new AppError("VALIDATION_ERROR", `${key} can't be written`, { recovery: "review" });
    const t = f.providerType;
    const text = (s: unknown) => [
      { type: "text", text: { content: String(s ?? "").slice(0, 2000) } },
    ];
    switch (t) {
      case "title":
        out[f.propertyId] = { title: text(value) };
        break;
      case "rich_text":
        out[f.propertyId] = { rich_text: value === null ? [] : text(value) };
        break;
      case "number":
        out[f.propertyId] = { number: value === null ? null : Number(value) };
        break;
      case "select":
        out[f.propertyId] = { select: value === null ? null : { name: String(value) } };
        break;
      case "status":
        out[f.propertyId] = { status: value === null ? null : { name: String(value) } };
        break;
      case "multi_select":
        out[f.propertyId] = {
          multi_select: ((value as string[] | null) ?? []).map((name) => ({ name })),
        };
        break;
      case "checkbox":
        out[f.propertyId] = { checkbox: value === true };
        break;
      case "date": {
        const d = value as { start: string; end?: string | null } | null;
        out[f.propertyId] = {
          date: d ? { start: d.start, ...(d.end ? { end: d.end } : {}) } : null,
        };
        break;
      }
      case "url":
      case "email":
      case "phone_number":
        out[f.propertyId] = { [t]: value === null || value === "" ? null : String(value) };
        break;
      default:
        throw new AppError("VALIDATION_ERROR", `${f.label} can't be written`, {
          recovery: "review",
        });
    }
  }
  return out;
}

// ── API calls ────────────────────────────────────────────────────────────────

export class NotionStructuredApi {
  constructor(private readonly http: NotionHttp) {}

  /** Databases' data sources the user shared with ELISE (search sees only shared ones). */
  async searchDataSources(query: string): Promise<NotionDataSource[]> {
    const res = await this.http.request<{ results: NotionDataSource[] }>(
      "POST",
      "/search",
      { query, filter: { property: "object", value: "data_source" }, page_size: 50 },
      true,
    );
    return res.results.filter((r) => r.object === "data_source" && !r.in_trash);
  }

  dataSource(id: string): Promise<NotionDataSource> {
    return this.http.request<NotionDataSource>("GET", `/data_sources/${encodeURIComponent(id)}`);
  }

  query(
    dataSourceId: string,
    body: { filter?: unknown; sorts?: unknown[]; page_size: number; start_cursor?: string },
  ) {
    return this.http.request<{
      results: NotionRowPage[];
      has_more: boolean;
      next_cursor: string | null;
    }>("POST", `/data_sources/${encodeURIComponent(dataSourceId)}/query`, body, true);
  }

  page(pageId: string): Promise<NotionRowPage> {
    return this.http.request<NotionRowPage>("GET", `/pages/${encodeURIComponent(pageId)}`);
  }

  createPage(dataSourceId: string, properties: Record<string, unknown>): Promise<NotionRowPage> {
    return this.http.request<NotionRowPage>("POST", "/pages", {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties,
    });
  }

  updatePage(pageId: string, body: { properties?: Record<string, unknown>; in_trash?: boolean }) {
    return this.http.request<NotionRowPage>("PATCH", `/pages/${encodeURIComponent(pageId)}`, body);
  }
}
