import "server-only";

import { createHash } from "node:crypto";

import { fingerprint as fp, norm, type TransactionType } from "@/core/capabilities/finance";
import { AppError, toAppError } from "@/core/errors";
import { matchEntitiesWithAI, suggestMappingWithAI } from "@/core/finance/ai-mapping";
import {
  bodyRows,
  buildFinancePreview,
  detectFormats,
  financeMappingSchema,
  normalizeAll,
  SYNC_IMPORT_ROWS,
  type Cell,
  type EntityDecision,
  type FinanceField,
  type FinanceMapping,
  type FinancePreview,
  type NormalizedTransaction,
  type RowResult,
} from "@/core/finance/import";
import {
  detectHeaderRow,
  inferFinanceMapping,
  pickTransactionSheet,
} from "@/core/finance/inference";
import {
  displayName,
  distinctNames,
  entityKey,
  resolveName,
  type Named,
  type Resolution,
} from "@/core/finance/resolve";
import { getAIProvider } from "@/infrastructure/ai";
import {
  isBackgroundConfigured,
  TriggerDevBackgroundRuntime,
} from "@/infrastructure/background/trigger/runtime";
import { parseSpreadsheet, spreadsheetKind } from "@/infrastructure/finance/spreadsheet";
import { logger } from "@/infrastructure/observability/logger";
import { GoogleSheetsClient } from "@/infrastructure/providers/google/sheets";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { ImportRow, Json } from "@/infrastructure/supabase/database.types";
import {
  createFinanceUploadUrl,
  downloadFinanceImport,
  financeImportPath,
  removeFinanceImport,
} from "@/infrastructure/supabase/storage";

import type { AuthContext } from "./auth-context";
import { workspaceContext } from "./background";
import { googleHttpFor } from "./elise";

/**
 * Finance imports (docs/architecture/10 §37-43, 16 §57-59). Upload (or pick a Google Sheet) →
 * inspect columns → mapping suggested (rules + AI) → the user reviews a full preview →
 * confirm → rows become ELISE Finance transactions with import provenance. Large imports run
 * in the background. Nothing is written before the user confirms, and invalid rows are shown.
 */

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
type Db = AuthContext["db"];

interface StoredMapping extends Partial<FinanceMapping> {
  sheet?: string;
}

export interface ImportInspection {
  importId: string;
  label: string;
  sourceType: ImportRow["source_type"];
  sheets: string[];
  sheet: string;
  headers: string[];
  sample: Cell[][];
  rows: number;
  mapping: FinanceMapping;
  fromAI: FinanceField[];
  /** Columns ELISE understood and left out (copies of the amount, empty columns…). */
  ignored: { header: string; reason: "duplicate" | "empty" | "unused" }[];
  /** A previous completed import of exactly the same file. */
  sameFile: { importedAt: string; imported: number } | null;
}

/** One name of the file and what it becomes (ADR-073). */
export interface EntityView {
  key: string;
  raw: string;
  /** Rows that use it. */
  rows: number;
  how: Resolution["how"];
  /** The existing record it maps to (absent: created, or waiting for the user). */
  id: string | null;
  name: string;
  candidates: Named[];
  /** Categories only. */
  type?: "income" | "expense";
}

export interface ImportPreviewView extends FinancePreview {
  creates: { categories: string[]; accounts: string[] };
  /** Every account and category name of the file, resolved once (ADR-073). */
  entities: { accounts: EntityView[]; categories: EntityView[] };
  /** Valid rows held back until a name is decided (ambiguous account, unknown destination). */
  review: number;
  /** Everything the user can choose from when correcting a name. */
  catalog: { accounts: Named[]; categories: (Named & { type: string })[] };
  sameFile: ImportInspection["sameFile"];
  /** This sheet is also connected as a live source: it stops counting there after importing. */
  connectedSource: string | null;
}

async function own(db: Db, workspaceId: string, importId: string) {
  const { data } = await db
    .from("imports")
    .select("*")
    .eq("id", importId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Import not found");
  return data;
}

export { detectHeaderRow };

async function loadRows(
  auth: AuthContext,
  imp: ImportRow,
  sheet?: string,
): Promise<{ sheets: string[]; sheet: string; rows: Cell[][] }> {
  if (imp.source_type === "google_sheets") {
    const [spreadsheetId, sheetId] = imp.source_reference.split("#");
    if (!imp.connection_id || !spreadsheetId) {
      throw new AppError("AUTH_EXPIRED", "The Google account for this sheet was disconnected", {
        recovery: "reconnect",
      });
    }
    const client = new GoogleSheetsClient(googleHttpFor(auth, imp.connection_id));
    const info = await client.spreadsheet(spreadsheetId);
    const tab = info.tabs.find((t) => String(t.sheetId) === sheetId) ?? info.tabs[0];
    if (!tab) throw new AppError("NOT_FOUND", "That tab no longer exists in the spreadsheet");
    return {
      sheets: [tab.title],
      sheet: tab.title,
      rows: await client.values(spreadsheetId, tab.title),
    };
  }
  if (!imp.file_path) throw new AppError("NOT_FOUND", "The uploaded file is missing");
  const bytes = await downloadFinanceImport(imp.workspace_id, imp.file_path);
  const parsed = await parseSpreadsheet(bytes, imp.source_type);
  // The sheet asked for, else the one that clearly holds transactions (ADR-073).
  const chosen = parsed.find((s) => s.name === sheet) ?? pickTransactionSheet(parsed) ?? parsed[0];
  if (!chosen || chosen.rows.length === 0)
    throw new AppError("VALIDATION_ERROR", "This file has no rows to import", {
      recovery: "review",
    });
  return { sheets: parsed.map((s) => s.name), sheet: chosen.name, rows: chosen.rows };
}

// ── Step 1: create the import and upload the file ────────────────────────────

export async function prepareFileImport(
  auth: AuthContext,
  file: { name: string; size: number; type: string | null },
) {
  const kind = spreadsheetKind(file.name, file.type);
  if (!kind) {
    throw new AppError("VALIDATION_ERROR", "Use a CSV or .xlsx file", { recovery: "review" });
  }
  if (file.size <= 0 || file.size > MAX_IMPORT_BYTES) {
    throw new AppError("VALIDATION_ERROR", "Files up to 20 MB", { recovery: "review" });
  }
  const { data, error } = await auth.db
    .from("imports")
    .insert({
      workspace_id: auth.workspaceId,
      import_type: "finance_transactions",
      source_type: kind,
      source_reference: file.name.slice(0, 300),
      source_label: file.name.slice(0, 300),
      created_by_user_id: auth.userId,
    })
    .select("id")
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", "Could not start the import", { cause: error });
  const path = financeImportPath(auth.workspaceId, data.id, file.name);
  await auth.db
    .from("imports")
    .update({ file_path: path })
    .eq("id", data.id)
    .eq("workspace_id", auth.workspaceId);
  const upload = await createFinanceUploadUrl(auth.workspaceId, path);
  return { importId: data.id, path: upload.path, token: upload.token };
}

/** "Import to ELISE" from a Google Sheet: the rows become ELISE Finance transactions. */
export async function prepareSheetsImport(
  auth: AuthContext,
  input: { connectionId: string; spreadsheetId: string; sheetId: number },
) {
  const client = new GoogleSheetsClient(googleHttpFor(auth, input.connectionId));
  const info = await client.spreadsheet(input.spreadsheetId);
  const tab = info.tabs.find((t) => t.sheetId === input.sheetId);
  if (!tab) throw new AppError("NOT_FOUND", "That tab doesn't exist in the spreadsheet");
  const { data, error } = await auth.db
    .from("imports")
    .insert({
      workspace_id: auth.workspaceId,
      import_type: "finance_transactions",
      source_type: "google_sheets",
      source_reference: `${info.id}#${tab.sheetId}`,
      source_label: `${info.title} · ${tab.title}`.slice(0, 300),
      connection_id: input.connectionId,
      status: "uploaded",
      created_by_user_id: auth.userId,
    })
    .select("id")
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", "Could not start the import", { cause: error });
  return { importId: data.id };
}

// ── Step 2: inspect columns and suggest a mapping ────────────────────────────

export async function inspectImport(
  auth: AuthContext,
  importId: string,
  sheet?: string,
): Promise<ImportInspection> {
  const started = Date.now();
  const imp = await own(auth.db, auth.workspaceId, importId);
  if (imp.status !== "uploading" && imp.status !== "uploaded")
    throw new AppError("CONFLICT", "This import already ran", { recovery: "review" });

  let sameFile: ImportInspection["sameFile"] = null;
  if (imp.source_type !== "google_sheets" && imp.file_path) {
    const bytes = await downloadFinanceImport(auth.workspaceId, imp.file_path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const { data: previous } = await auth.db
      .from("imports")
      .select("completed_at, imported_rows")
      .eq("workspace_id", auth.workspaceId)
      .eq("file_hash", hash)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    sameFile = previous?.completed_at
      ? { importedAt: previous.completed_at, imported: previous.imported_rows }
      : null;
    await auth.db
      .from("imports")
      .update({ file_hash: hash, status: "uploaded" })
      .eq("id", importId)
      .eq("workspace_id", auth.workspaceId);
  }

  const loaded = await loadRows(auth, imp, sheet);
  const headerRow = detectHeaderRow(loaded.rows);
  const headers = loaded.rows[headerRow] ?? [];
  const body = bodyRows(loaded.rows, headerRow).map((r) => r.cells);
  const ai = (() => {
    try {
      return getAIProvider();
    } catch {
      return null;
    }
  })();
  // Values decide first (ADR-073); the model only fills what they leave open.
  const inferred = inferFinanceMapping(headers, body);
  const suggestion = await suggestMappingWithAI(ai, headers, body.slice(0, 5), {
    columns: inferred.columns,
    ignored: inferred.ignored.filter((i) => i.reason === "duplicate").map((i) => i.index),
  });
  const formats = detectFormats(loaded.rows, suggestion.columns, headerRow);
  const mapping = financeMappingSchema.parse({
    columns: suggestion.columns,
    headerRow,
    numberFormat: formats.numberFormat,
    dateFormat: formats.dateFormat,
    defaultCurrency: suggestion.columns.currency === undefined ? inferred.currency : null,
  });
  const mappedColumns = new Set(Object.values(mapping.columns));
  await auth.db
    .from("imports")
    .update({ mapping_config: { ...mapping, sheet: loaded.sheet } as unknown as Json })
    .eq("id", importId)
    .eq("workspace_id", auth.workspaceId);
  logger.info("finance_import_analysis", {
    import_id: importId,
    file_type: imp.source_type,
    sheets: loaded.sheets.length,
    rows: body.length,
    columns: headers.length,
    mapped: mappedColumns.size,
    ai_fields: suggestion.fromAI.length,
    latency_ms: Date.now() - started,
  });
  return {
    importId,
    label: imp.source_label ?? imp.source_reference,
    sourceType: imp.source_type,
    sheets: loaded.sheets,
    sheet: loaded.sheet,
    headers,
    sample: body.slice(0, 5).map((r) => r.map((c) => c.slice(0, 80))),
    rows: body.length,
    mapping,
    fromAI: suggestion.fromAI,
    ignored: inferred.ignored
      .filter((i) => !mappedColumns.has(i.index))
      .map((i) => ({ header: (headers[i.index] ?? "").slice(0, 60), reason: i.reason })),
    sameFile,
  };
}

// ── Step 3: preview with the user's mapping ──────────────────────────────────

/** Fingerprints ELISE Finance already has in a date range (for duplicate detection). */
async function existingFingerprints(db: Db, workspaceId: string, from: string, to: string) {
  const set = new Set<string>();
  for (let offset = 0; offset < 200_000; offset += 1000) {
    const { data } = await db
      .from("finance_transactions")
      .select("fingerprint")
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .gte("transaction_date", from)
      .lte("transaction_date", to)
      .range(offset, offset + 999);
    for (const r of data ?? []) set.add(r.fingerprint);
    if ((data ?? []).length < 1000) break;
  }
  return set;
}

function dateSpan(rows: Cell[][], mapping: FinanceMapping) {
  const dates = normalizeAll(rows, mapping)
    .flatMap((r) => (r.ok ? [r.tx.date] : []))
    .sort();
  return dates.length ? { from: dates[0]!, to: dates.at(-1)! } : null;
}

async function connectedSourceFor(db: Db, workspaceId: string, imp: ImportRow) {
  if (imp.source_type !== "google_sheets") return null;
  const [spreadsheetId, sheetId] = imp.source_reference.split("#");
  const { data } = await db
    .from("finance_sources")
    .select("id, display_name")
    .eq("workspace_id", workspaceId)
    .eq("spreadsheet_id", spreadsheetId!)
    .eq("sheet_id", Number(sheetId))
    .is("archived_at", null)
    .maybeSingle();
  return data;
}

export async function previewFinanceImport(
  auth: AuthContext,
  importId: string,
  rawMapping: unknown,
): Promise<ImportPreviewView> {
  const imp = await own(auth.db, auth.workspaceId, importId);
  if (imp.status !== "uploaded")
    throw new AppError("CONFLICT", "This import already ran", { recovery: "review" });
  const mapping = financeMappingSchema.parse(rawMapping);
  const stored = imp.mapping_config as StoredMapping;
  const { rows } = await loadRows(auth, imp, stored.sheet);
  const span = dateSpan(rows, mapping);
  const existing = span
    ? await existingFingerprints(auth.db, auth.workspaceId, span.from, span.to)
    : new Set<string>();
  const preview = buildFinancePreview(rows, mapping, existing);

  // Every account and category name, resolved once for the whole file (ADR-073).
  const results = normalizeAll(rows, mapping);
  const catalog = await readCatalog(auth.db, auth.workspaceId);
  const aliases = await readAliases(auth.db, auth.workspaceId, auth.userId);
  const resolved = await resolveEntities(results, mapping, catalog, aliases, aiOrNull());
  const decided = { ...mapping, entities: resolved.decisions };
  const held = heldRows(results, resolved);
  const connected = await connectedSourceFor(auth.db, auth.workspaceId, imp);

  await auth.db
    .from("imports")
    .update({
      mapping_config: { ...decided, sheet: stored.sheet } as unknown as Json,
      total_rows: preview.totalRows,
      valid_rows: preview.valid - held.size,
      invalid_rows: preview.invalid + held.size,
      duplicate_rows: preview.duplicates,
    })
    .eq("id", importId)
    .eq("workspace_id", auth.workspaceId);

  const created = (list: EntityView[]) => [
    ...new Set(list.filter((e) => e.how === "created").map((e) => e.name)),
  ];
  return {
    ...preview,
    willImport: Math.max(0, preview.willImport - held.size),
    review: held.size,
    creates: {
      categories: created(resolved.categories).slice(0, 30),
      accounts: created(resolved.accounts).slice(0, 30),
    },
    entities: { accounts: resolved.accounts, categories: resolved.categories },
    catalog: {
      accounts: catalog.accounts.map(({ id, name }) => ({ id, name })),
      categories: catalog.categories.map(({ id, name, category_type }) => ({
        id,
        name,
        type: category_type,
      })),
    },
    sameFile: null,
    connectedSource: connected?.display_name ?? null,
  };
}

// ── Accounts and categories: one decision per name (ADR-073) ─────────────────

const aiOrNull = () => {
  try {
    return getAIProvider();
  } catch {
    return null;
  }
};

type Catalog = {
  accounts: Named[];
  categories: (Named & { category_type: string })[];
};

async function readCatalog(db: Db, workspaceId: string): Promise<Catalog> {
  const [{ data: cats }, { data: accts }] = await Promise.all([
    db
      .from("finance_categories")
      .select("id, name, category_type")
      .eq("workspace_id", workspaceId)
      .is("archived_at", null),
    db
      .from("finance_accounts")
      .select("id, name")
      .eq("workspace_id", workspaceId)
      .is("archived_at", null),
  ]);
  return { accounts: accts ?? [], categories: cats ?? [] };
}

const ALIASES = "finance.import.aliases";
type Aliases = { accounts: Record<string, string>; categories: Record<string, string> };

/** The person's own past decisions ("Cash" → their "Efectivo"), never another workspace's. */
async function readAliases(db: Db, workspaceId: string, userId: string): Promise<Aliases> {
  const { data } = await db
    .from("user_preferences")
    .select("value_json")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .eq("key", ALIASES)
    .maybeSingle();
  const v = (data?.value_json ?? {}) as Partial<Aliases>;
  return { accounts: v.accounts ?? {}, categories: v.categories ?? {} };
}

const categoryKey = (type: string, key: string) => `${type}|${key}`;
const categoriesFor = (catalog: Catalog, type: string) =>
  catalog.categories.filter((c) => c.category_type === type || c.category_type === "both");

interface ResolvedEntities {
  accounts: EntityView[];
  categories: EntityView[];
  decisions: FinanceMapping["entities"];
  /** Account keys that can't be placed yet, and transfer destinations that aren't accounts. */
  reviewAccounts: Set<string>;
  reviewCategories: Set<string>;
}

/**
 * The names of the valid rows → existing records, new ones, or "the user decides". Decisions
 * already in the mapping (the user's corrections, or a previous preview) win; then the rules;
 * then one model call for whatever is left; then a new record. A transfer's destination must
 * be an existing account or one the file itself uses — never invented.
 */
async function resolveEntities(
  results: RowResult[],
  mapping: FinanceMapping,
  catalog: Catalog,
  aliases: Aliases,
  ai: ReturnType<typeof aiOrNull>,
): Promise<ResolvedEntities> {
  const txs = results.flatMap((r) => (r.ok ? [r.tx] : []));
  const decisions: FinanceMapping["entities"] = { accounts: {}, categories: {} };
  const reviewAccounts = new Set<string>();
  const reviewCategories = new Set<string>();
  const known = (id: string, list: Named[]) => list.some((e) => e.id === id);

  const accountNames = distinctNames(txs.flatMap((t) => [t.account, t.toAccount]));
  const fileAccounts = new Set(distinctNames(txs.map((t) => t.account)).map((n) => n.key));
  const categoryNames = (["expense", "income"] as const).flatMap((type) =>
    distinctNames(txs.filter((t) => t.type === type).map((t) => t.category)).map((n) => ({
      ...n,
      type,
    })),
  );

  type Pending = { view: EntityView; existing: Named[]; decisionKey: string; aliasKey: string };
  const place = (
    n: { key: string; raw: string; count: number },
    existing: Named[],
    previous: EntityDecision | undefined,
    alias: Record<string, string>,
    aliasKey: string,
  ): { view: EntityView; open: boolean } => {
    const view: EntityView = {
      key: n.key,
      raw: n.raw,
      rows: n.count,
      how: "created",
      id: null,
      name: displayName(n.raw),
      candidates: [],
    };
    if (previous?.action === "match" && known(previous.id, existing)) {
      const hit = existing.find((e) => e.id === previous.id)!;
      return { view: { ...view, how: "exact", id: hit.id, name: hit.name }, open: false };
    }
    if (previous?.action === "create") return { view, open: false };
    const r = resolveName(n.raw, existing, { [n.key]: alias[aliasKey] ?? "" });
    if (!r) return { view, open: true };
    return {
      view: { ...view, how: r.how, id: r.id ?? null, name: r.name, candidates: r.candidates ?? [] },
      open: false,
    };
  };

  const pending: Pending[] = [];
  const accounts: EntityView[] = [];
  for (const n of accountNames) {
    const { view, open } = place(
      n,
      catalog.accounts,
      mapping.entities.accounts[n.key],
      aliases.accounts,
      n.key,
    );
    accounts.push(view);
    if (open)
      pending.push({ view, existing: catalog.accounts, decisionKey: n.key, aliasKey: n.key });
  }
  const categories: EntityView[] = [];
  for (const n of categoryNames) {
    const existing = categoriesFor(catalog, n.type);
    const key = categoryKey(n.type, n.key);
    const { view, open } = place(
      n,
      existing,
      mapping.entities.categories[key],
      aliases.categories,
      key,
    );
    const typed = { ...view, type: n.type };
    categories.push(typed);
    if (open) pending.push({ view: typed, existing, decisionKey: key, aliasKey: key });
  }

  // One model call for every name the rules couldn't place (never one per row).
  const openAccounts = pending.filter((p) => !p.view.type);
  const openCategories = pending.filter((p) => p.view.type);
  if (pending.length) {
    const semantic = await matchEntitiesWithAI(ai, {
      accounts: { names: openAccounts.map((p) => p.view.raw), existing: catalog.accounts },
      categories: {
        names: openCategories.map((p) => p.view.raw),
        existing: catalog.categories,
      },
    });
    for (const p of pending) {
      const id = (p.view.type ? semantic.categories : semantic.accounts)[p.view.raw];
      const hit = id ? p.existing.find((e) => e.id === id) : undefined;
      if (hit) Object.assign(p.view, { how: "semantic", id: hit.id, name: hit.name });
    }
  }

  for (const a of accounts) {
    // A destination nobody has and the file never uses as an account isn't an account.
    const destinationOnly =
      !fileAccounts.has(a.key) && !a.id && mapping.entities.accounts[a.key]?.action !== "create";
    if (a.how === "review" || destinationOnly) {
      reviewAccounts.add(a.key);
      if (destinationOnly && a.how !== "review") a.how = "review";
      continue;
    }
    decisions.accounts[a.key] = a.id ? { action: "match", id: a.id } : { action: "create" };
  }
  for (const c of categories) {
    const key = categoryKey(c.type!, c.key);
    if (c.how === "review") {
      reviewCategories.add(key);
      continue;
    }
    decisions.categories[key] = c.id ? { action: "match", id: c.id } : { action: "create" };
  }
  const byRows = (a: EntityView, b: EntityView) => b.rows - a.rows;
  return {
    accounts: accounts.sort(byRows),
    categories: categories.sort(byRows),
    decisions,
    reviewAccounts,
    reviewCategories,
  };
}

/** Rows that wait for the user: they use a name still to decide (ADR-073). */
function heldRows(
  results: RowResult[],
  resolved: Pick<ResolvedEntities, "reviewAccounts" | "reviewCategories">,
): Set<number> {
  const held = new Set<number>();
  for (const r of results) if (r.ok && needsReview(r.tx, resolved)) held.add(r.row);
  return held;
}

function needsReview(
  t: NormalizedTransaction,
  resolved: Pick<ResolvedEntities, "reviewAccounts" | "reviewCategories">,
) {
  const keys = [t.account, t.toAccount].flatMap((n) => (n ? [entityKey(n)] : []));
  if (t.type === "transfer" && (!t.account || !t.toAccount)) return true;
  return (
    keys.some((k) => resolved.reviewAccounts.has(k)) ||
    (t.type !== "transfer" &&
      t.category !== null &&
      resolved.reviewCategories.has(categoryKey(t.type, entityKey(t.category))))
  );
}

// ── Step 4: confirm and import ───────────────────────────────────────────────

export async function confirmFinanceImport(
  auth: AuthContext,
  importId: string,
): Promise<{ status: "completed"; imported: number } | { status: "importing" }> {
  const imp = await own(auth.db, auth.workspaceId, importId);
  if (imp.status !== "uploaded")
    throw new AppError("CONFLICT", "This import already ran", { recovery: "review" });
  if (!imp.valid_rows)
    throw new AppError("VALIDATION_ERROR", "There are no valid rows to import", {
      recovery: "review",
    });
  await auth.db
    .from("imports")
    .update({ status: "importing", started_at: new Date().toISOString() })
    .eq("id", importId)
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "uploaded");

  if (imp.valid_rows <= SYNC_IMPORT_ROWS) {
    const imported = await runFinanceImport(auth.workspaceId, importId);
    return { status: "completed", imported };
  }
  // Large imports never run inside a request.
  if (!isBackgroundConfigured()) {
    await auth.db
      .from("imports")
      .update({ status: "uploaded", started_at: null })
      .eq("id", importId)
      .eq("workspace_id", auth.workspaceId);
    throw new AppError(
      "CAPABILITY_UNAVAILABLE",
      `Imports over ${SYNC_IMPORT_ROWS} rows run in the background, which isn't configured on this server.`,
      { recovery: "configure" },
    );
  }
  const { runtimeJobId } = await new TriggerDevBackgroundRuntime().enqueue({
    type: "finance.import",
    payload: { workspaceId: auth.workspaceId, importId },
    idempotencyKey: `finance-import:${importId}`,
  });
  await auth.db
    .from("imports")
    .update({ runtime_job_id: runtimeJobId })
    .eq("id", importId)
    .eq("workspace_id", auth.workspaceId);
  return { status: "importing" };
}

type CatalogRow = { id: string; name: string; category_type?: string };

/** Rows written per round (and progress steps): small enough to stay well inside limits. */
const CHUNK = 100;

/**
 * Writes one confirmed import (inline for small files, from the background task otherwise).
 * Runs with the service role, every statement scoped to the import's workspace. Safe to run
 * again (a Trigger retry, a second click): it first removes what an earlier attempt left, then
 * imports from the start, so no row is ever written twice. Rows are written in chunks; each
 * chunk records its rows, which is the progress the screen shows (ADR-073).
 */
export async function runFinanceImport(workspaceId: string, importId: string): Promise<number> {
  const db = createAdminClient();
  const started = Date.now();
  const imp = await own(db, workspaceId, importId);
  if (imp.status === "completed") return imp.imported_rows;
  if (imp.status !== "importing")
    throw new AppError("CONFLICT", "This import is not waiting to run");
  const userId = imp.created_by_user_id;
  try {
    await db
      .from("finance_transactions")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("import_id", importId);
    await db.from("import_rows").delete().eq("workspace_id", workspaceId).eq("import_id", importId);

    const stored = imp.mapping_config as StoredMapping;
    // `sheet` is stored beside the mapping, not part of it (the schema is strict).
    const { sheet, ...storedMapping } = stored;
    const mapping = financeMappingSchema.parse(storedMapping);
    const { rows } = await loadRows(await workspaceContext(workspaceId), imp, sheet);
    const results = normalizeAll(rows, mapping);
    const span = dateSpan(rows, mapping);
    const existing = span
      ? await existingFingerprints(db, workspaceId, span.from, span.to)
      : new Set<string>();
    const header = rows[mapping.headerRow] ?? [];
    const raw = (cells: Cell[] | undefined) =>
      Object.fromEntries(
        (cells ?? [])
          .slice(0, 30)
          .map((c, i) => [(header[i] || `col${i + 1}`).slice(0, 60), c.slice(0, 200)]),
      );
    const cellsByRow = new Map(bodyRows(rows, mapping.headerRow).map((b) => [b.row, b.cells]));

    const catalog = await loadCatalog(db, workspaceId);
    // The decisions made at preview (and the user's corrections) are final here: no model call.
    const resolved = await resolveEntities(
      results,
      mapping,
      await readCatalog(db, workspaceId),
      userId ? await readAliases(db, workspaceId, userId) : { accounts: {}, categories: {} },
      null,
    );
    // The same transfer seen from both accounts ("Transfer-Out" and "Transfer-In") is one.
    // ponytail: two identical transfers on one day between the same accounts count once.
    const transfers = new Set<string>();

    type Planned = {
      row: number;
      status: "imported" | "invalid" | "duplicate";
      normalized: unknown;
      errors: unknown;
      insert?: Record<string, unknown>;
    };
    const plan = async (r: RowResult): Promise<Planned> => {
      if (!r.ok) return { row: r.row, status: "invalid", normalized: null, errors: r.issues };
      if (needsReview(r.tx, resolved))
        return { row: r.row, status: "invalid", normalized: r.tx, errors: ["needs_review"] };
      if (existing.has(r.tx.fingerprint) && !mapping.includeDuplicates)
        return { row: r.row, status: "duplicate", normalized: r.tx, errors: null };
      if (r.tx.type === "transfer") {
        const pair = [r.tx.date, r.tx.amount, r.tx.currency, r.tx.account, r.tx.toAccount]
          .map((v) => norm(v ?? ""))
          .join("|");
        if (transfers.has(pair))
          return { row: r.row, status: "duplicate", normalized: r.tx, errors: ["paired_transfer"] };
        transfers.add(pair);
        if (!catalog.v2)
          return { row: r.row, status: "invalid", normalized: r.tx, errors: ["transfer_accounts"] };
      }
      // What the file doesn't say, ELISE's history may: the same counterparty or description
      // was classified before (deterministic; shown in the preview, never invented).
      const learned = r.tx.category && r.tx.book ? null : catalog.learned(r.tx);
      const categoryId =
        r.tx.type !== "transfer" && r.tx.category
          ? await catalog.category(r.tx.category, r.tx.type, mapping.entities)
          : r.tx.type === "transfer"
            ? null
            : (learned?.category_id ?? null);
      const accountId = r.tx.account ? await catalog.account(r.tx.account, mapping.entities) : null;
      const toAccountId =
        r.tx.type === "transfer" && r.tx.toAccount
          ? await catalog.account(r.tx.toAccount, mapping.entities)
          : null;
      const bookId = catalog.v2
        ? r.tx.book
          ? await catalog.book(r.tx.book)
          : (mapping.defaultBookId ??
            learned?.book_id ??
            catalog.accountBook(accountId) ??
            catalog.defaultBook)
        : undefined;
      return {
        row: r.row,
        status: "imported",
        normalized: r.tx,
        errors: null,
        insert: {
          workspace_id: workspaceId,
          transaction_type: r.tx.type,
          amount: r.tx.amount,
          currency: r.tx.currency,
          transaction_date: r.tx.date,
          description: r.tx.description,
          counterparty: r.tx.counterparty,
          account_id: accountId,
          category_id: categoryId,
          subcategory: r.tx.subcategory ?? learned?.subcategory ?? null,
          payment_method: r.tx.paymentMethod ?? (accountId ? null : r.tx.account),
          project: r.tx.project,
          status: r.tx.status,
          notes: r.tx.notes,
          source: "import",
          import_id: importId,
          import_row_number: r.row,
          external_reference: r.tx.reference,
          fingerprint: fp(r.tx),
          created_by_user_id: userId,
          ...(catalog.v2
            ? { book_id: bookId ?? null, receipt: r.tx.reference, to_account_id: toAccountId }
            : {}),
        },
      };
    };

    const counts = { imported: 0, invalid: 0, duplicates: 0, review: 0 };
    for (let i = 0; i < results.length; i += CHUNK) {
      const planned: Planned[] = [];
      for (const r of results.slice(i, i + CHUNK)) planned.push(await plan(r));
      const inserts = planned.flatMap((p) => (p.insert ? [p.insert] : []));
      const created = new Map<number, string>();
      if (inserts.length) {
        const { data, error } = await db
          .from("finance_transactions")
          .insert(inserts as never)
          .select("id, import_row_number");
        if (error)
          throw new AppError("INTERNAL_ERROR", "Could not write the transactions", {
            cause: error,
          });
        for (const t of data ?? []) created.set(t.import_row_number!, t.id);
      }
      const { error } = await db.from("import_rows").insert(
        planned.map((r) => ({
          workspace_id: workspaceId,
          import_id: importId,
          source_row_number: r.row,
          raw_data: raw(cellsByRow.get(r.row)) as Json,
          normalized_data: (r.normalized ?? null) as Json,
          status: r.status,
          error_details: (r.errors ?? null) as Json,
          created_resource_type: r.status === "imported" ? "finance_transaction" : null,
          created_resource_id: r.status === "imported" ? (created.get(r.row) ?? null) : null,
        })),
      );
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not record the import rows", { cause: error });
      counts.imported += created.size;
      counts.duplicates += planned.filter((r) => r.status === "duplicate").length;
      counts.invalid += planned.filter((r) => r.status === "invalid").length;
      counts.review += planned.filter(
        (r) => r.status === "invalid" && JSON.stringify(r.errors).includes("needs_review"),
      ).length;
      logger.info("finance_import_progress", {
        import_id: importId,
        processed: Math.min(i + CHUNK, results.length),
        total: results.length,
        ...counts,
      });
    }

    const now = new Date().toISOString();
    await db
      .from("imports")
      .update({
        status: "completed",
        completed_at: now,
        imported_rows: counts.imported,
        invalid_rows: counts.invalid,
        duplicate_rows: counts.duplicates,
        valid_rows: counts.imported + counts.duplicates,
        total_rows: results.length,
        error_code: null,
      })
      .eq("id", importId)
      .eq("workspace_id", workspaceId);
    // The same sheet connected live would now be counted twice: stop counting it there.
    const connected = await connectedSourceFor(db, workspaceId, imp);
    if (connected) {
      await db
        .from("finance_sources")
        .update({ include_in_totals: false })
        .eq("id", connected.id)
        .eq("workspace_id", workspaceId);
    }
    if (userId) await rememberAliases(db, workspaceId, userId, resolved).catch(() => undefined);
    if (imp.file_path) await removeFinanceImport(workspaceId, imp.file_path).catch(() => undefined);
    await db.from("audit_events").insert({
      workspace_id: workspaceId,
      user_id: userId,
      event_type: "finance.import.completed",
      resource_type: "import",
      resource_id: importId,
      origin: "user_ui",
      result: "success",
      metadata: { ...counts, rows: results.length, sourceType: imp.source_type },
    });
    logger.info("finance.import.completed", {
      import_id: importId,
      rows: results.length,
      ...counts,
      ms: Date.now() - started,
    });
    return counts.imported;
  } catch (error) {
    const code = toAppError(error).code;
    await db
      .from("finance_transactions")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("import_id", importId);
    await db
      .from("imports")
      .update({ status: "failed", error_code: code })
      .eq("id", importId)
      .eq("workspace_id", workspaceId);
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    logger.warn("finance.import.failed", {
      import_id: importId,
      code,
      // The database error class (e.g. 23514 check, 23505 unique), never row values.
      ...(cause?.code ? { db_code: cause.code } : {}),
    });
    throw error;
  }
}

/**
 * After an import: names that meant something else in the user's words ("Cash" → their
 * "Efectivo") are remembered for this person and workspace only, so the next file resolves
 * them without asking anyone.
 */
async function rememberAliases(
  db: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  userId: string,
  resolved: ResolvedEntities,
) {
  const current = await readAliases(db, workspaceId, userId);
  const learn = (
    views: EntityView[],
    keyOf: (v: EntityView) => string,
    into: Record<string, string>,
  ) => {
    for (const v of views) if (v.id && entityKey(v.name) !== v.key) into[keyOf(v)] = v.id;
  };
  learn(resolved.accounts, (v) => v.key, current.accounts);
  learn(resolved.categories, (v) => categoryKey(v.type!, v.key), current.categories);
  // Bounded: the most recent few hundred names per kind.
  const trim = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).slice(-300));
  await db.from("user_preferences").upsert(
    {
      workspace_id: workspaceId,
      user_id: userId,
      key: ALIASES,
      value_json: { accounts: trim(current.accounts), categories: trim(current.categories) },
      source: "system",
    },
    { onConflict: "workspace_id,user_id,key" },
  );
}

/** Categories and accounts, resolved through the import's decisions (created once if new). */
async function loadCatalog(db: ReturnType<typeof createAdminClient>, workspaceId: string) {
  const [{ data: cats }, { data: accts }, books, history] = await Promise.all([
    db
      .from("finance_categories")
      .select("id, name, category_type")
      .eq("workspace_id", workspaceId)
      .is("archived_at", null),
    db.from("finance_accounts").select("*").eq("workspace_id", workspaceId).is("archived_at", null),
    db
      .from("finance_books")
      .select("id, name, is_default")
      .eq("workspace_id", workspaceId)
      .is("archived_at", null),
    db
      .from("finance_transactions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .is("archived_at", null)
      .not("category_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(3000),
  ]);
  const categories: CatalogRow[] = cats ?? [];
  const accounts: (CatalogRow & { default_book_id?: string | null })[] = accts ?? [];
  // Books exist from migration 039 on; before it, imports simply carry no Book.
  const v2 = !books.error;
  const bookRows: { id: string; name: string; is_default: boolean }[] = books.data ?? [];
  // Learned classification: the latest classified record per counterparty/description.
  const learnedBy = new Map<
    string,
    { category_id: string | null; subcategory: string | null; book_id: string | null }
  >();
  for (const t of history.data ?? []) {
    const key = norm(t.counterparty || t.description || "");
    if (key && !learnedBy.has(key))
      learnedBy.set(key, {
        category_id: t.category_id,
        subcategory: t.subcategory,
        book_id: t.book_id ?? null,
      });
  }
  // One record per name per import: "Cash", "cash" and "CASH" create one account.
  const createdAccounts = new Map<string, string>();
  const createdCategories = new Map<string, string>();
  return {
    v2,
    defaultBook: bookRows.find((b) => b.is_default)?.id ?? null,
    accountBook(accountId: string | null) {
      return accounts.find((a) => a.id === accountId)?.default_book_id ?? null;
    },
    learned(tx: { counterparty: string | null; description: string | null }) {
      return learnedBy.get(norm(tx.counterparty || tx.description || "")) ?? null;
    },
    async book(name: string) {
      const hit = bookRows.find((b) => norm(b.name) === norm(name));
      if (hit) return hit.id;
      const { data, error } = await db
        .from("finance_books")
        .insert({ workspace_id: workspaceId, name, book_type: "other" })
        .select("id, name, is_default")
        .single();
      if (error) throw new AppError("INTERNAL_ERROR", "Could not create a Book", { cause: error });
      bookRows.push(data);
      return data.id;
    },
    async category(name: string, type: TransactionType, entities: FinanceMapping["entities"]) {
      const key = categoryKey(type, entityKey(name));
      const decision = entities.categories[key];
      if (decision?.action === "match" && categories.some((c) => c.id === decision.id))
        return decision.id;
      const exact = categories.find(
        (c) =>
          entityKey(c.name) === entityKey(name) &&
          (c.category_type === type || c.category_type === "both"),
      );
      if (exact) return exact.id;
      const made = createdCategories.get(key);
      if (made) return made;
      const { data, error } = await db
        .from("finance_categories")
        .insert({
          workspace_id: workspaceId,
          name: displayName(name),
          category_type: type === "transfer" ? "both" : type,
          source: "import",
        })
        .select("id, name, category_type")
        .single();
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not create a category", { cause: error });
      categories.push(data);
      createdCategories.set(key, data.id);
      return data.id;
    },
    async account(name: string, entities: FinanceMapping["entities"]) {
      const key = entityKey(name);
      const decision = entities.accounts[key];
      if (decision?.action === "match" && accounts.some((a) => a.id === decision.id))
        return decision.id;
      const exact = accounts.find((a) => entityKey(a.name) === key);
      if (exact) return exact.id;
      const made = createdAccounts.get(key);
      if (made) return made;
      const { data, error } = await db
        .from("finance_accounts")
        .insert({ workspace_id: workspaceId, name: displayName(name), source: "import" })
        .select("id, name")
        .single();
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not create an account", { cause: error });
      accounts.push(data);
      createdAccounts.set(key, data.id);
      return data.id;
    },
  };
}

/** Where an import is now: progress while it runs, the result when it's done (ADR-073). */
export async function financeImportStatus(auth: AuthContext, importId: string) {
  const imp = await own(auth.db, auth.workspaceId, importId);
  const { count } = await auth.db
    .from("import_rows")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", auth.workspaceId)
    .eq("import_id", importId);
  const { count: review } = await auth.db
    .from("import_rows")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", auth.workspaceId)
    .eq("import_id", importId)
    .eq("status", "invalid")
    .contains("error_details", ["needs_review"]);
  return {
    status: imp.status,
    total: imp.total_rows,
    processed: imp.status === "completed" ? imp.total_rows : (count ?? 0),
    imported: imp.imported_rows,
    duplicates: imp.duplicate_rows,
    invalid: imp.invalid_rows,
    review: review ?? 0,
    errorCode: imp.error_code,
  };
}

export async function cancelFinanceImport(auth: AuthContext, importId: string) {
  const imp = await own(auth.db, auth.workspaceId, importId);
  if (imp.status !== "uploading" && imp.status !== "uploaded") return;
  await auth.db
    .from("imports")
    .update({ status: "cancelled" })
    .eq("id", importId)
    .eq("workspace_id", auth.workspaceId);
  if (imp.file_path)
    await removeFinanceImport(auth.workspaceId, imp.file_path).catch(() => undefined);
}

export interface ImportSummary {
  id: string;
  label: string;
  sourceType: ImportRow["source_type"];
  status: ImportRow["status"];
  imported: number;
  invalid: number;
  duplicates: number;
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
}

export async function listFinanceImports(auth: AuthContext): Promise<ImportSummary[]> {
  const { data } = await auth.db
    .from("imports")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .eq("import_type", "finance_transactions")
    .in("status", ["importing", "completed", "failed", "rolled_back"])
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []).map((i) => ({
    id: i.id,
    label: i.source_label ?? i.source_reference,
    sourceType: i.source_type,
    status: i.status,
    imported: i.imported_rows,
    invalid: i.invalid_rows,
    duplicates: i.duplicate_rows,
    createdAt: i.created_at,
    completedAt: i.completed_at,
    errorCode: i.error_code,
  }));
}

/** Rows of an import that need attention (invalid), for the "Review issues" view. */
export async function importIssues(auth: AuthContext, importId: string) {
  const { data } = await auth.db
    .from("import_rows")
    .select("source_row_number, raw_data, error_details")
    .eq("workspace_id", auth.workspaceId)
    .eq("import_id", importId)
    .eq("status", "invalid")
    .order("source_row_number")
    .limit(200);
  return (data ?? []).map((r) => ({
    row: r.source_row_number,
    cells: r.raw_data as Record<string, string>,
    issues: (r.error_details ?? []) as string[],
  }));
}
