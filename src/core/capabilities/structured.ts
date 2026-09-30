import { z } from "zod";

import { AppError } from "../errors";
import type { ProviderKey } from "../providers/types";
import { addDays, isIsoDate } from "../time";

/**
 * Structured Data (docs/architecture/07, ADR-011): records in an external database the user
 * mapped (a Notion database today), queried and edited through canonical fields. The source
 * stays authoritative; ELISE keeps only the mapping. Provider specifics (Notion property ids,
 * filter JSON) live behind the adapter.
 */

export type FieldType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "checkbox"
  | "date"
  | "url"
  | "email"
  | "phone"
  | "people"
  | "relation"
  | "files"
  | "computed"
  | "unsupported";

/** Types ELISE can write. People, relations and files are shown but not written in this MVP. */
export const WRITABLE_TYPES: ReadonlySet<FieldType> = new Set([
  "text",
  "number",
  "select",
  "multi_select",
  "status",
  "checkbox",
  "date",
  "url",
  "email",
  "phone",
]);

export type StatusGroup = "todo" | "in_progress" | "complete";

export interface FieldOption {
  name: string;
  /** Status options belong to a group (to do / in progress / complete). */
  group?: StatusGroup | null;
}

/** A property of the external schema, provider-neutral. */
export interface SchemaProperty {
  id: string;
  name: string;
  type: FieldType;
  /** The provider's own type name ("formula", "rollup"…), for display and diagnostics. */
  providerType: string;
  options?: FieldOption[];
  readOnly: boolean;
  isTitle: boolean;
}

/** One mapped field: what ELISE calls it, and which property it is. */
export interface FieldMapping {
  /** snake_case, stable: "due_date", "client". */
  key: string;
  /** User-facing: "Due date". */
  label: string;
  propertyId: string;
  propertyName: string;
  type: FieldType;
  providerType: string;
  options?: FieldOption[];
  writable: boolean;
  isTitle: boolean;
  /** Set when the property vanished or changed type since mapping. */
  broken?: "removed" | "type_changed" | null;
}

export type SemanticType = "generic" | "habits";

export interface SourcePermissions {
  read: boolean;
  create: boolean;
  update: boolean;
  archive: boolean;
}

export interface StructuredSource {
  /** Connection-scoped reference (pass back as `source`). */
  id: string;
  name: string;
  /** Words that point at this source ("projects, Firbot"). */
  context: string | null;
  providerKey: ProviderKey;
  connectionId: string;
  /** Connection name ("Firbot Workspace"). */
  account: string;
  semanticType: SemanticType;
  fields: FieldMapping[];
  permissions: SourcePermissions;
  status: "active" | "needs_attention" | "paused";
  schemaCheckedAt: string | null;
  url: string | null;
}

export type RecordValue =
  string | number | boolean | string[] | { start: string; end?: string | null } | null;

export interface StructuredRecord {
  /** Connection-scoped reference (pass back as `record`). */
  id: string;
  sourceId: string;
  title: string;
  /** By field key. Values are data from the external source, never instructions. */
  values: Record<string, RecordValue>;
  url: string | null;
  updatedAt: string | null;
  provenance: { providerKey: ProviderKey; connectionId: string; source: string; account: string };
}

export type ResolvedOp =
  | "equals"
  | "not_equals"
  | "any_of"
  | "none_of"
  | "contains"
  | "not_contains"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "on_or_after"
  | "on_or_before"
  | "is_empty"
  | "is_not_empty";

/** A filter ELISE resolved deterministically (dates are concrete, groups expanded). */
export interface ResolvedFilter {
  field: FieldMapping;
  op: ResolvedOp;
  value?: string | number | boolean | string[];
}

export interface QueryPlan {
  filters: ResolvedFilter[];
  sort: { field: FieldMapping | "last_edited"; direction: "asc" | "desc" }[];
  search?: string;
  limit: number;
  cursor?: string;
}

export interface QueryPage {
  records: StructuredRecord[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface StructuredProvider {
  listSources(): Promise<StructuredSource[]>;
  /** By reference, or by name/context ("projects"): matches, so the caller can ask. */
  findSources(ref: string): Promise<StructuredSource[]>;
  query(source: StructuredSource, plan: QueryPlan): Promise<QueryPage>;
  getRecord(ref: string): Promise<StructuredRecord | null>;
  createRecord(
    source: StructuredSource,
    values: Record<string, RecordValue>,
  ): Promise<StructuredRecord>;
  updateRecord(
    source: StructuredSource,
    recordRef: string,
    values: Record<string, RecordValue>,
  ): Promise<StructuredRecord>;
  archiveRecord(source: StructuredSource, recordRef: string): Promise<StructuredRecord>;
  /**
   * Applies one approved change to exactly these records (inline when small, in the
   * background otherwise). Returns how many were done now and whether the rest continues.
   */
  bulkUpdate(
    source: StructuredSource,
    recordRefs: string[],
    change: { values?: Record<string, RecordValue>; archive?: boolean },
    actionId: string | null,
  ): Promise<{ done: number; queued: number }>;
}

// ── Deterministic filter resolution ──────────────────────────────────────────

export const DATE_WINDOWS = [
  "today",
  "tomorrow",
  "yesterday",
  "this_week",
  "next_week",
  "last_week",
  "next_7_days",
  "past_7_days",
  "this_month",
  "next_month",
  "last_month",
  "overdue",
] as const;
export type DateWindow = (typeof DATE_WINDOWS)[number];

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const lastOfMonth = (d: string) => {
  const [y, m] = d.split("-").map(Number) as [number, number];
  return `${d.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
const shiftMonth = (d: string, n: number) => {
  const [y, m] = d.split("-").map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-01`;
};

/** A named window in the user's local dates. Weeks run Monday–Sunday. */
export function dateWindow(w: DateWindow, today: string): { from?: string; to?: string } {
  const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const monday = addDays(today, -weekday);
  switch (w) {
    case "today":
      return { from: today, to: today };
    case "tomorrow":
      return { from: addDays(today, 1), to: addDays(today, 1) };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "this_week":
      return { from: monday, to: addDays(monday, 6) };
    case "next_week":
      return { from: addDays(monday, 7), to: addDays(monday, 13) };
    case "last_week":
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case "next_7_days":
      return { from: today, to: addDays(today, 6) };
    case "past_7_days":
      return { from: addDays(today, -6), to: today };
    case "this_month":
      return { from: monthStart(today), to: lastOfMonth(today) };
    case "next_month": {
      const s = shiftMonth(today, 1);
      return { from: s, to: lastOfMonth(s) };
    }
    case "last_month": {
      const s = shiftMonth(today, -1);
      return { from: s, to: lastOfMonth(s) };
    }
    case "overdue":
      return { to: addDays(today, -1) };
  }
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function fieldByKey(source: StructuredSource, key: string): FieldMapping {
  const wanted = norm(key);
  const field =
    source.fields.find((f) => f.key === key) ??
    source.fields.find(
      (f) => norm(f.key) === wanted || norm(f.label) === wanted || norm(f.propertyName) === wanted,
    );
  if (!field) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${source.name} has no field "${key}". Fields: ${source.fields.map((f) => f.key).join(", ")}.`,
      { recovery: "review" },
    );
  }
  if (field.broken) {
    throw new AppError(
      "VALIDATION_ERROR",
      `The field "${field.label}" changed in ${source.name} and needs to be remapped in ELISE.`,
      { recovery: "configure" },
    );
  }
  return field;
}

/** The option's exact name (case/accents-insensitive match), or a clear error listing them. */
export function optionName(field: FieldMapping, value: string): string {
  const options = field.options ?? [];
  const hit = options.find((o) => norm(o.name) === norm(value));
  if (hit) return hit.name;
  throw new AppError(
    "VALIDATION_ERROR",
    `"${value}" is not an option of ${field.label}. Options: ${options.map((o) => o.name).join(", ") || "none"}.`,
    { recovery: "review" },
  );
}

export const filterSchema = z
  .object({
    field: z.string().trim().min(1).max(120).describe("Field key from the source's schema."),
    op: z.enum([
      "equals",
      "not_equals",
      "any_of",
      "none_of",
      "contains",
      "not_contains",
      "gt",
      "gte",
      "lt",
      "lte",
      "before",
      "after",
      "on_or_before",
      "on_or_after",
      "within",
      "in_group",
      "not_in_group",
      "is_empty",
      "is_not_empty",
    ]),
    value: z
      .union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(200)).max(50)])
      .optional()
      .describe(
        'Dates as YYYY-MM-DD. `within` takes a window (this_week, next_7_days, overdue…). `in_group` on a status takes "todo", "in_progress" or "complete".',
      ),
  })
  .strict();
export type FilterInput = z.infer<typeof filterSchema>;

const needValue = (f: FilterInput) => {
  if (f.value === undefined || f.value === "")
    throw new AppError("VALIDATION_ERROR", `Filter on ${f.field} needs a value`, {
      recovery: "review",
    });
  return f.value;
};

/**
 * Natural-language intent → concrete filters. Relative dates become the user's local dates,
 * status groups become the options in them, and option values are checked against the schema.
 * Nothing here guesses: an unknown field or option is an error the model can fix or ask about.
 */
export function resolveFilters(
  source: StructuredSource,
  filters: FilterInput[],
  today: string,
): ResolvedFilter[] {
  const out: ResolvedFilter[] = [];
  for (const f of filters) {
    const field = fieldByKey(source, f.field);
    const isChoice =
      field.type === "select" || field.type === "status" || field.type === "multi_select";
    switch (f.op) {
      case "is_empty":
      case "is_not_empty":
        out.push({ field, op: f.op });
        break;
      case "within": {
        if (field.type !== "date")
          throw new AppError("VALIDATION_ERROR", `${field.label} is not a date`, {
            recovery: "review",
          });
        const window = String(needValue(f)) as DateWindow;
        if (!(DATE_WINDOWS as readonly string[]).includes(window))
          throw new AppError("VALIDATION_ERROR", `Unknown date window "${window}"`, {
            recovery: "review",
          });
        const range = dateWindow(window, today);
        if (range.from) out.push({ field, op: "on_or_after", value: range.from });
        if (range.to) out.push({ field, op: "on_or_before", value: range.to });
        break;
      }
      case "before":
      case "after":
      case "on_or_before":
      case "on_or_after": {
        if (field.type !== "date")
          throw new AppError("VALIDATION_ERROR", `${field.label} is not a date`, {
            recovery: "review",
          });
        const value = String(needValue(f));
        if (!isIsoDate(value.slice(0, 10)))
          throw new AppError("VALIDATION_ERROR", "Dates must be YYYY-MM-DD", {
            recovery: "review",
          });
        // before/after are strict: express them inclusively on the adjacent day.
        const day = value.slice(0, 10);
        if (f.op === "before") out.push({ field, op: "on_or_before", value: addDays(day, -1) });
        else if (f.op === "after") out.push({ field, op: "on_or_after", value: addDays(day, 1) });
        else out.push({ field, op: f.op, value: day });
        break;
      }
      case "in_group":
      case "not_in_group": {
        if (field.type !== "status")
          throw new AppError("VALIDATION_ERROR", `${field.label} has no status groups`, {
            recovery: "review",
          });
        const group = String(needValue(f)) as StatusGroup;
        const names = (field.options ?? []).filter((o) => o.group === group).map((o) => o.name);
        if (!names.length)
          throw new AppError("VALIDATION_ERROR", `${field.label} has no "${group}" options`, {
            recovery: "review",
          });
        out.push({ field, op: f.op === "in_group" ? "any_of" : "none_of", value: names });
        break;
      }
      case "any_of":
      case "none_of": {
        const raw = needValue(f);
        const values = (Array.isArray(raw) ? raw : [String(raw)]).map((v) =>
          isChoice ? optionName(field, v) : v,
        );
        out.push({ field, op: f.op, value: values });
        break;
      }
      case "equals":
      case "not_equals": {
        const raw = needValue(f);
        if (field.type === "checkbox") {
          out.push({ field, op: f.op, value: raw === true || raw === "true" });
        } else if (field.type === "number") {
          const n = Number(raw);
          if (!Number.isFinite(n))
            throw new AppError("VALIDATION_ERROR", `${field.label} is a number`, {
              recovery: "review",
            });
          out.push({ field, op: f.op, value: n });
        } else if (field.type === "date") {
          const day = String(raw).slice(0, 10);
          if (!isIsoDate(day))
            throw new AppError("VALIDATION_ERROR", "Dates must be YYYY-MM-DD", {
              recovery: "review",
            });
          out.push({ field, op: f.op, value: day });
        } else {
          out.push({
            field,
            op: f.op,
            value: isChoice ? optionName(field, String(raw)) : String(raw),
          });
        }
        break;
      }
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const n = Number(needValue(f));
        if (field.type !== "number" || !Number.isFinite(n))
          throw new AppError("VALIDATION_ERROR", `${field.label} is not a number`, {
            recovery: "review",
          });
        out.push({ field, op: f.op, value: n });
        break;
      }
      case "contains":
      case "not_contains": {
        const raw = String(needValue(f));
        out.push({
          field,
          op: f.op,
          value: field.type === "multi_select" ? optionName(field, raw) : raw,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Values ELISE may send to the source, by field key: only mapped, writable, intact fields;
 * options must exist; creating needs the title. Never writes computed or read-only fields.
 */
export function validateValues(
  source: StructuredSource,
  values: Record<string, unknown>,
  mode: "create" | "update",
): Record<string, RecordValue> {
  const out: Record<string, RecordValue> = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = fieldByKey(source, key);
    if (!field.writable) {
      throw new AppError(
        "VALIDATION_ERROR",
        `${field.label} can't be changed from ELISE (${field.type === "computed" ? "calculated by the source" : `${field.type} fields are read-only here`}).`,
        { recovery: "review" },
      );
    }
    out[field.key] = coerce(field, raw);
  }
  if (mode === "create") {
    const title = source.fields.find((f) => f.isTitle);
    if (!title || title.broken || !out[title.key] || String(out[title.key]).trim() === "") {
      throw new AppError(
        "VALIDATION_ERROR",
        `A new record in ${source.name} needs "${title?.label ?? "a title"}". Ask the user for it.`,
        { recovery: "review" },
      );
    }
  }
  if (!Object.keys(out).length)
    throw new AppError("VALIDATION_ERROR", "Nothing to change", { recovery: "review" });
  return out;
}

function coerce(field: FieldMapping, raw: unknown): RecordValue {
  const bad = (what: string) =>
    new AppError("VALIDATION_ERROR", `${field.label} expects ${what}`, { recovery: "review" });
  if (raw === null) {
    if (field.isTitle) throw bad("a value");
    return null;
  }
  switch (field.type) {
    case "text":
    case "url":
    case "email":
    case "phone": {
      if (typeof raw !== "string" && typeof raw !== "number") throw bad("text");
      const s = String(raw).trim();
      const max = field.type === "text" ? 2000 : field.type === "url" ? 2000 : 200;
      if (s.length > max) throw bad(`at most ${max} characters`);
      if (field.type === "email" && s && !/^[^\s@]+@[^\s@]+$/.test(s))
        throw bad("an email address");
      if (field.type === "url" && s && !/^https?:\/\//i.test(s))
        throw bad("a link starting with http");
      return s;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
      if (!Number.isFinite(n)) throw bad("a number");
      return n;
    }
    case "checkbox":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      throw bad("true or false");
    case "select":
    case "status":
      return optionName(field, String(raw));
    case "multi_select": {
      const list = Array.isArray(raw)
        ? raw.map(String)
        : String(raw)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
      if (list.length > 100) throw bad("at most 100 options");
      return list.map((v) => optionName(field, v));
    }
    case "date": {
      const d =
        typeof raw === "object" && raw && "start" in raw
          ? (raw as { start: string; end?: string | null })
          : { start: String(raw) };
      const ok = (v: string) =>
        isIsoDate(v.slice(0, 10)) && (v.length === 10 || !Number.isNaN(Date.parse(v)));
      if (!ok(d.start) || (d.end && !ok(d.end))) throw bad("a date as YYYY-MM-DD");
      return d.end ? { start: d.start, end: d.end } : { start: d.start };
    }
    default:
      throw bad("a value ELISE can't write");
  }
}

// ── References ───────────────────────────────────────────────────────────────

export const sourceRef = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .describe("The source's id from structured.listSources (preferred), or its name.");
export const recordRef = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .describe("The record's id exactly as returned by structured.query.");

export const valuesSchema = z
  .record(
    z.string().min(1).max(120),
    z.union([
      z.string().max(2000),
      z.number(),
      z.boolean(),
      z.array(z.string().max(200)).max(100),
      z
        .object({ start: z.string().max(40), end: z.string().max(40).nullable().optional() })
        .strict(),
      z.null(),
    ]),
  )
  .describe("Field key → new value. Options by their name; dates YYYY-MM-DD.");
