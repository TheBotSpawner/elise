import type {
  FieldMapping,
  QueryPlan,
  ResolvedFilter,
  StructuredSource,
} from "../capabilities/structured";

/**
 * "¿Cuál es mi último post publicado?" (ADR-114): the latest by PUBLICATION date among the
 * PUBLISHED records — not the last edited, not the first row. Deterministic, from the mapped
 * schema only; when the source has no publication date the plan falls back to the last edit and
 * says so, so ELISE never presents an edit date as a publication date.
 */

const PUB_DATE = /public|publish|posted|lanzamiento|release|salida|emitid/i;
const PUBLISHED = /^publicad|^published$|^publicado|^live$|^en vivo$|^subid|^posteado|^emitid/i;
const PUBLISHED_FLAG = /publicad|published/i;

export interface LatestPlan {
  /** The publication date the records are sorted by, or null (fallback to last edit). */
  dateField: FieldMapping | null;
  /** How "published" is decided, or null when the source has no such field. */
  published: ResolvedFilter | null;
  plan: Omit<QueryPlan, "limit" | "cursor">;
  /** Plain words for the model: what "latest" means here. */
  criterion: string;
}

const usable = (f: FieldMapping) => !f.broken;

export function publicationDateField(source: StructuredSource): FieldMapping | null {
  return (
    source.fields.find(
      (f) =>
        usable(f) &&
        (f.type === "date" || f.providerType === "created_time") &&
        PUB_DATE.test(`${f.label} ${f.propertyName}`),
    ) ?? null
  );
}

export function publishedFilter(source: StructuredSource): ResolvedFilter | null {
  for (const f of source.fields) {
    if (!usable(f) || (f.type !== "status" && f.type !== "select")) continue;
    const names = (f.options ?? []).map((o) => o.name).filter((n) => PUBLISHED.test(n.trim()));
    if (names.length) return { field: f, op: "any_of", value: names };
  }
  const flag = source.fields.find(
    (f) => usable(f) && f.type === "checkbox" && PUBLISHED_FLAG.test(f.label),
  );
  return flag ? { field: flag, op: "equals", value: true } : null;
}

export function latestPlan(source: StructuredSource, opts: { publishedOnly: boolean }): LatestPlan {
  const dateField = publicationDateField(source);
  const published = opts.publishedOnly ? publishedFilter(source) : null;
  const filters: ResolvedFilter[] = [];
  if (published) filters.push(published);
  if (dateField && dateField.providerType !== "created_time")
    filters.push({ field: dateField, op: "is_not_empty" });
  const sort: QueryPlan["sort"] = dateField
    ? [
        { field: dateField, direction: "desc" },
        { field: "last_edited", direction: "desc" },
      ]
    : [{ field: "last_edited", direction: "desc" }];
  const parts = [
    dateField
      ? `the most recent "${dateField.label}"`
      : `no publication-date field exists in ${source.name}, so the most recently EDITED record (say so: it's not a publication date)`,
    published
      ? `among records where "${published.field.label}" is ${
          published.op === "equals" ? "checked" : (published.value as string[]).join(" / ")
        }`
      : opts.publishedOnly
        ? `(${source.name} has no published status: say it can't tell published from drafts)`
        : "",
  ].filter(Boolean);
  return { dateField, published, plan: { filters, sort }, criterion: parts.join(" ") };
}
