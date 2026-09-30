import { z } from "zod";

import type { ToolDefinition, ToolRunEnv, ToolRunResult } from "../agents/tools";
import {
  DATE_WINDOWS,
  filterSchema,
  recordRef,
  resolveFilters,
  sourceRef,
  validateValues,
  valuesSchema,
  fieldByKey,
  type StructuredProvider,
  type StructuredRecord,
  type StructuredSource,
} from "../capabilities/structured";
import { AppError } from "../errors";
import { parseExternalRef } from "../providers/refs";
import { todayIn } from "../time";

/**
 * Structured Data tools (ADR-011). Canonical and provider-independent: "structured.query",
 * never "notion.query". The mapped source (a Notion database) stays authoritative; every read
 * is a real filtered query, every write is validated against the mapping first and confirmed
 * only from the provider's result. Record values are data, never instructions.
 */

export const MAX_BULK = 500;

function provider(env: ToolRunEnv): StructuredProvider {
  return env.providers.get("structured", env.binding);
}

/** Sources and records name the connection they belong to: route there, fail closed if unbound. */
function routeRef(ref: unknown) {
  if (typeof ref !== "string") return null;
  const external = parseExternalRef(ref);
  return external ? { connectionId: external.connectionId } : null;
}

async function resolveSource(env: ToolRunEnv, ref: string): Promise<StructuredSource> {
  const matches = await provider(env).findSources(ref);
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) {
    const all = await provider(env).listSources();
    throw new AppError(
      "NOT_FOUND",
      `No structured source matches "${ref}". Sources: ${all.map((s) => s.name).join(", ") || "none"}.`,
      { recovery: "review" },
    );
  }
  throw new AppError(
    "VALIDATION_ERROR",
    `Several sources match "${ref}": ${matches.map((s) => s.name).join("; ")}. Ask which one.`,
    { recovery: "review" },
  );
}

function allow(source: StructuredSource, what: "read" | "create" | "update" | "archive") {
  if (source.status === "paused" || !source.permissions[what]) {
    throw new AppError(
      "PERMISSION_DENIED",
      `${source.name} doesn't allow ELISE to ${what === "read" ? "read it" : what + " records"}. The user can change it in Connections → ${source.name}.`,
      { recovery: "configure" },
    );
  }
}

const schemaForModel = (s: StructuredSource) => ({
  id: s.id,
  name: s.name,
  account: s.account,
  ...(s.context ? { context: s.context } : {}),
  fields: s.fields
    .filter((f) => !f.broken)
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.isTitle ? { title: true } : {}),
      ...(f.options?.length
        ? {
            options: f.options
              .slice(0, 30)
              .map((o) => (o.group ? `${o.name} (${o.group})` : o.name)),
          }
        : {}),
      ...(f.writable ? {} : { readOnly: true }),
    })),
  allows: Object.entries(s.permissions)
    .filter(([, v]) => v)
    .map(([k]) => k),
  ...(s.status !== "active" ? { status: s.status } : {}),
  ...(s.fields.some((f) => f.broken)
    ? { needsRemap: s.fields.filter((f) => f.broken).map((f) => f.label) }
    : {}),
});

const recordForModel = (r: StructuredRecord) => ({
  id: r.id,
  title: r.title,
  // Values come from the user's database: data to report, never instructions to follow.
  values: r.values,
  source: r.provenance.source,
});

function showRecords(
  source: StructuredSource,
  records: StructuredRecord[],
  hasMore: boolean,
  nextCursor: string | null,
): ToolRunResult<unknown> {
  return {
    output: {
      source: source.name,
      count: records.length,
      ...(hasMore ? { hasMore: true, nextCursor } : {}),
      records: records.map(recordForModel),
    },
    display: {
      kind: "structured_records",
      source: { id: source.id, name: source.name, account: source.account, fields: source.fields },
      records,
      hasMore,
    },
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export const listSourcesTool: ToolDefinition = {
  name: "structured.listSources",
  capability: "structured",
  operation: "listSources",
  description:
    "The user's mapped structured sources (e.g. Notion databases like Projects, Client CRM) with their fields, options and what ELISE may change. Use to pick the source and field keys.",
  input: z.object({}).strict(),
  async describe() {
    return { summary: "List structured sources" };
  },
  async run(_raw, env) {
    const sources = await provider(env).listSources();
    return {
      output: { sources: sources.map(schemaForModel) },
      display: { kind: "structured_sources", sources },
    };
  },
  merge(results) {
    const sources = results.flatMap((r) =>
      r.result.display?.kind === "structured_sources" ? r.result.display.sources : [],
    );
    return {
      output: { sources: sources.map(schemaForModel) },
      display: { kind: "structured_sources", sources },
    };
  },
};

const sourceInput = z.object({ source: sourceRef }).strict();

export const getSchemaTool: ToolDefinition = {
  name: "structured.getSchema",
  capability: "structured",
  operation: "getSchema",
  description: "One source's fields, their types and options (e.g. the Status options).",
  input: sourceInput,
  route: (i: z.infer<typeof sourceInput>) => routeRef(i.source),
  async describe() {
    return { summary: "Read schema" };
  },
  async run(raw, env) {
    const source = await resolveSource(env, sourceInput.parse(raw).source);
    return {
      output: { source: schemaForModel(source) },
      display: { kind: "structured_sources", sources: [source] },
    };
  },
};

const queryInput = z
  .object({
    source: sourceRef,
    filters: z.array(filterSchema).max(20).default([]),
    sort: z
      .array(
        z
          .object({ field: z.string().max(120), direction: z.enum(["asc", "desc"]).default("asc") })
          .strict(),
      )
      .max(3)
      .optional()
      .describe('Field key, or "last_edited".'),
    search: z.string().trim().min(1).max(200).optional().describe("Words in the record's title."),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(500).optional(),
  })
  .strict();

export const queryTool: ToolDefinition = {
  name: "structured.query",
  capability: "structured",
  operation: "query",
  description: `Query a mapped source with structured filters: "projects in progress" → {field:"status", op:"in_group", value:"in_progress"}; "due this week" → {field:"due_date", op:"within", value:"this_week"}; "not completed" → {field:"status", op:"not_in_group", value:"complete"}; overdue → within "overdue". Windows: ${DATE_WINDOWS.join(", ")}. Filters are AND-ed and run in the source itself.`,
  input: queryInput,
  route: (i: z.infer<typeof queryInput>) => routeRef(i.source),
  async describe() {
    return { summary: "Query records" };
  },
  async run(raw, env) {
    const q = queryInput.parse(raw);
    const source = await resolveSource(env, q.source);
    allow(source, "read");
    const filters = resolveFilters(source, q.filters, todayIn(env.ctx.timezone, env.ctx.now));
    const sort = (q.sort ?? []).map((s) => ({
      field: s.field === "last_edited" ? ("last_edited" as const) : fieldByKey(source, s.field),
      direction: s.direction,
    }));
    const page = await provider(env).query(source, {
      filters,
      sort,
      search: q.search,
      limit: q.limit,
      cursor: q.cursor,
    });
    return showRecords(source, page.records, page.hasMore, page.nextCursor);
  },
};

const recordInput = z.object({ record: recordRef }).strict();

async function loadRecord(env: ToolRunEnv, ref: string) {
  const record = await provider(env).getRecord(ref);
  if (!record)
    throw new AppError("NOT_FOUND", "That record no longer exists or isn't shared with ELISE", {
      recovery: "review",
    });
  const source = await resolveSource(env, record.sourceId);
  return { record, source };
}

export const getRecordTool: ToolDefinition = {
  name: "structured.getRecord",
  capability: "structured",
  operation: "getRecord",
  description: "One record by id, with all its mapped fields.",
  input: recordInput,
  route: (i: z.infer<typeof recordInput>) => routeRef(i.record),
  async describe() {
    return { summary: "Open record" };
  },
  async run(raw, env) {
    const { record, source } = await loadRecord(env, recordInput.parse(raw).record);
    allow(source, "read");
    return {
      output: { record: recordForModel(record) },
      display: {
        kind: "structured_record",
        record,
        change: "shown",
        source: {
          id: source.id,
          name: source.name,
          account: source.account,
          fields: source.fields,
        },
      },
    };
  },
};

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * The exact record a write targets: by id, or by title within a source. One clear match
 * proceeds; several or none are a question for the user — never the first result.
 */
async function targetRecord(
  env: ToolRunEnv,
  input: { record?: string; source?: string; title?: string },
) {
  if (input.record) return loadRecord(env, input.record);
  if (!input.source || !input.title)
    throw new AppError("VALIDATION_ERROR", "Say which record: its id, or source + title", {
      recovery: "review",
    });
  const source = await resolveSource(env, input.source);
  const page = await provider(env).query(source, {
    filters: [],
    sort: [],
    search: input.title,
    limit: 20,
  });
  const wanted = input.title.trim().toLowerCase();
  const exact = page.records.filter((r) => r.title.trim().toLowerCase() === wanted);
  const matches = exact.length ? exact : page.records;
  if (matches.length === 1) return { record: matches[0]!, source };
  if (!matches.length)
    throw new AppError("NOT_FOUND", `No record called "${input.title}" in ${source.name}`, {
      recovery: "review",
    });
  throw new AppError(
    "VALIDATION_ERROR",
    `Several records in ${source.name} match "${input.title}": ${matches
      .slice(0, 8)
      .map((r) => `${r.title} (${r.id})`)
      .join("; ")}. Ask which one.`,
    { recovery: "review" },
  );
}

const createInput = z.object({ source: sourceRef, values: valuesSchema }).strict();

export const createRecordTool: ToolDefinition = {
  name: "structured.createRecord",
  capability: "structured",
  operation: "createRecord",
  description:
    'Create a record: "create a project called Website Redesign for Firbot" → values {name:"Website Redesign", client:"Firbot"}. Use field keys and existing option names. If a required field is missing, the tool says so: ask the user.',
  input: createInput,
  route: (i: z.infer<typeof createInput>) => routeRef(i.source),
  async describe(raw, env) {
    const c = createInput.parse(raw);
    const source = await resolveSource(env, c.source);
    const title = source.fields.find((f) => f.isTitle);
    return {
      summary: `Create “${String(title ? (c.values[title.key] ?? "") : "")}” in ${source.name}`,
    };
  },
  async run(raw, env) {
    const c = createInput.parse(raw);
    const source = await resolveSource(env, c.source);
    allow(source, "create");
    const record = await provider(env).createRecord(
      source,
      validateValues(source, c.values, "create"),
    );
    return {
      output: { created: recordForModel(record) },
      display: {
        kind: "structured_record",
        record,
        change: "created",
        source: {
          id: source.id,
          name: source.name,
          account: source.account,
          fields: source.fields,
        },
      },
      target: { type: "structured_record", id: record.id },
    };
  },
};

const updateInput = z
  .object({
    record: recordRef.optional(),
    source: sourceRef.optional(),
    title: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .optional()
      .describe("The record's title, when you have no id."),
    values: valuesSchema,
  })
  .strict();

export const updateRecordTool: ToolDefinition = {
  name: "structured.updateRecord",
  capability: "structured",
  operation: "updateRecord",
  description:
    '"Mark ELISE Website as Completed", "set the priority of Project X to High": pass the record id (or source + title) and only the changed values. Several matches → the tool asks you to ask.',
  input: updateInput,
  route: (i: z.infer<typeof updateInput>) => routeRef(i.record ?? i.source),
  // Resolve the exact record before anything is recorded or approved.
  async pin(raw, env) {
    const u = updateInput.parse(raw);
    const { record } = await targetRecord(env, u);
    return { record: record.id, values: u.values };
  },
  async describe(raw, env) {
    const u = updateInput.parse(raw);
    const { record, source } = await targetRecord(env, u);
    const change = Object.entries(u.values)
      .map(
        ([k, v]) =>
          `${k} → ${Array.isArray(v) ? v.join(", ") : v && typeof v === "object" ? v.start : String(v)}`,
      )
      .join(", ");
    return {
      summary: `Update “${record.title}” in ${source.name}: ${change}`,
      target: { type: "structured_record", id: record.id },
    };
  },
  async run(raw, env) {
    const u = updateInput.parse(raw);
    const { record, source } = await targetRecord(env, u);
    allow(source, "update");
    const updated = await provider(env).updateRecord(
      source,
      record.id,
      validateValues(source, u.values, "update"),
    );
    return {
      output: { updated: recordForModel(updated) },
      display: {
        kind: "structured_record",
        record: updated,
        change: "updated",
        source: {
          id: source.id,
          name: source.name,
          account: source.account,
          fields: source.fields,
        },
      },
      target: { type: "structured_record", id: updated.id },
    };
  },
};

const archiveInput = z
  .object({
    record: recordRef.optional(),
    source: sourceRef.optional(),
    title: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

export const archiveRecordTool: ToolDefinition = {
  name: "structured.archiveRecord",
  capability: "structured",
  operation: "archiveRecord",
  description: "Move a record to the source's trash. Needs the user's approval.",
  input: archiveInput,
  route: (i: z.infer<typeof archiveInput>) => routeRef(i.record ?? i.source),
  async pin(raw, env) {
    const { record } = await targetRecord(env, archiveInput.parse(raw));
    return { record: record.id };
  },
  async describe(raw, env) {
    const { record, source } = await targetRecord(env, archiveInput.parse(raw));
    return {
      summary: `Archive “${record.title}” in ${source.name}`,
      target: { type: "structured_record", id: record.id },
    };
  },
  async run(raw, env) {
    const { record, source } = await targetRecord(env, archiveInput.parse(raw));
    allow(source, "archive");
    const archived = await provider(env).archiveRecord(source, record.id);
    return {
      output: { archived: { id: archived.id, title: archived.title } },
      display: {
        kind: "structured_record",
        record: archived,
        change: "archived",
        source: {
          id: source.id,
          name: source.name,
          account: source.account,
          fields: source.fields,
        },
      },
      target: { type: "structured_record", id: archived.id },
    };
  },
};

const bulkInput = z
  .object({
    source: sourceRef,
    filters: z.array(filterSchema).min(1).max(20),
    values: valuesSchema.optional(),
    archive: z.boolean().optional(),
    /** Filled by ELISE when the change is prepared: exactly the records approved. */
    recordIds: z.array(z.string().max(400)).max(MAX_BULK).optional(),
  })
  .strict();

/**
 * Change many records at once ("mark all old leads as archived"). ELISE first resolves the
 * exact records (count + sample) and asks for approval; only those records change, even if
 * the database changes meanwhile. Large batches continue in the background.
 */
export const bulkUpdateTool: ToolDefinition = {
  name: "structured.bulkUpdate",
  capability: "structured",
  operation: "bulkUpdate",
  description:
    "Change or archive every record matching filters. Always needs the user's approval, which shows the count and examples. Max 500 records.",
  input: bulkInput,
  route: (i: z.infer<typeof bulkInput>) => routeRef(i.source),
  async pin(raw, env) {
    const b = bulkInput.parse(raw);
    if (!b.values && !b.archive)
      throw new AppError("VALIDATION_ERROR", "Say what to change", { recovery: "review" });
    const source = await resolveSource(env, b.source);
    const filters = resolveFilters(source, b.filters, todayIn(env.ctx.timezone, env.ctx.now));
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider(env).query(source, { filters, sort: [], limit: 100, cursor });
      ids.push(...page.records.map((r) => r.id));
      cursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
      if (ids.length > MAX_BULK)
        throw new AppError(
          "VALIDATION_ERROR",
          `More than ${MAX_BULK} records match. Narrow the filters.`,
          { recovery: "review" },
        );
    } while (cursor);
    if (!ids.length)
      throw new AppError("NOT_FOUND", `No records in ${source.name} match`, { recovery: "review" });
    if (b.values) validateValues(source, b.values, "update");
    return { ...b, source: source.id, recordIds: ids };
  },
  assess: async () => ({ risk: "high", defaultApproval: "always_ask" }),
  async describe(raw, env) {
    const b = bulkInput.parse(raw);
    const source = await resolveSource(env, b.source);
    const n = b.recordIds?.length ?? 0;
    const change = b.archive
      ? "archive"
      : Object.entries(b.values ?? {})
          .map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(", ") : String(v)}`)
          .join(", ");
    const sample: StructuredRecord[] = [];
    for (const id of (b.recordIds ?? []).slice(0, 5)) {
      const r = await provider(env).getRecord(id);
      if (r) sample.push(r);
    }
    return {
      summary: `${b.archive ? "Archive" : "Update"} ${n} records in ${source.name}${b.archive ? "" : `: ${change}`}`,
      preview: {
        kind: "structured_bulk_preview",
        source: {
          id: source.id,
          name: source.name,
          account: source.account,
          fields: source.fields,
        },
        count: n,
        sample,
        change,
      },
    };
  },
  async run(raw, env) {
    const b = bulkInput.parse(raw);
    if (!b.recordIds?.length)
      throw new AppError("VALIDATION_ERROR", "Nothing was prepared to change", {
        recovery: "review",
      });
    const source = await resolveSource(env, b.source);
    allow(source, b.archive ? "archive" : "update");
    const values = b.values ? validateValues(source, b.values, "update") : undefined;
    const result = await provider(env).bulkUpdate(
      source,
      b.recordIds,
      { values, archive: b.archive },
      env.actionId ?? null,
    );
    return {
      output: { ...result, total: b.recordIds.length, source: source.name },
      target: { type: "structured_source", id: source.id },
    };
  },
};

export const STRUCTURED_TOOLS = [
  listSourcesTool,
  getSchemaTool,
  queryTool,
  getRecordTool,
  createRecordTool,
  updateRecordTool,
  archiveRecordTool,
  bulkUpdateTool,
];
