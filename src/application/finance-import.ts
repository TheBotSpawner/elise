import "server-only";

import { createHash } from "node:crypto";

import { fingerprint as fp, norm, type TransactionType } from "@/core/capabilities/finance";
import { AppError, toAppError } from "@/core/errors";
import { suggestMappingWithAI } from "@/core/finance/ai-mapping";
import {
  bodyRows,
  buildFinancePreview,
  detectFormats,
  financeMappingSchema,
  normalizeAll,
  SYNC_IMPORT_ROWS,
  type Cell,
  type FinanceField,
  type FinanceMapping,
  type FinancePreview,
} from "@/core/finance/import";
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
  /** A previous completed import of exactly the same file. */
  sameFile: { importedAt: string; imported: number } | null;
}

export interface ImportPreviewView extends FinancePreview {
  creates: { categories: string[]; accounts: string[] };
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

/** First of the top rows that looks like headers: 2+ filled cells, mostly text. */
export function detectHeaderRow(rows: Cell[][]): number {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const filled = rows[i]!.filter((c) => c.trim());
    const texty = filled.filter((c) => !/^[-\d.,$€\s/]+$/.test(c));
    if (filled.length >= 2 && texty.length >= Math.ceil(filled.length * 0.6)) return i;
  }
  return 0;
}

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
  const chosen =
    parsed.find((s) => s.name === sheet) ?? parsed.find((s) => s.rows.length > 1) ?? parsed[0];
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
  const suggestion = await suggestMappingWithAI(ai, headers, body.slice(0, 5));
  const formats = detectFormats(loaded.rows, suggestion.columns, headerRow);
  const mapping = financeMappingSchema.parse({
    columns: suggestion.columns,
    headerRow,
    numberFormat: formats.numberFormat,
    dateFormat: formats.dateFormat,
  });
  await auth.db
    .from("imports")
    .update({ mapping_config: { ...mapping, sheet: loaded.sheet } as unknown as Json })
    .eq("id", importId)
    .eq("workspace_id", auth.workspaceId);
  logger.info("finance.import.inspected", {
    import_id: importId,
    rows: body.length,
    columns: headers.length,
    ai_fields: suggestion.fromAI.length,
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

  // Names that will be created as categories / accounts (shown before confirming).
  const [{ data: cats }, { data: accts }] = await Promise.all([
    auth.db
      .from("finance_categories")
      .select("name, category_type")
      .eq("workspace_id", auth.workspaceId)
      .is("archived_at", null),
    auth.db
      .from("finance_accounts")
      .select("name")
      .eq("workspace_id", auth.workspaceId)
      .is("archived_at", null),
  ]);
  const known = new Set((cats ?? []).map((c) => `${c.category_type}|${norm(c.name)}`));
  const knownAccounts = new Set((accts ?? []).map((a) => norm(a.name)));
  const valid = normalizeAll(rows, mapping).flatMap((r) => (r.ok ? [r.tx] : []));
  const newCategories = new Map<string, string>();
  const newAccounts = new Map<string, string>();
  for (const t of valid) {
    if (
      t.category &&
      !known.has(`${t.type}|${norm(t.category)}`) &&
      !known.has(`both|${norm(t.category)}`)
    )
      newCategories.set(`${t.type}|${norm(t.category)}`, t.category);
    if (t.account && !knownAccounts.has(norm(t.account)))
      newAccounts.set(norm(t.account), t.account);
  }
  const connected = await connectedSourceFor(auth.db, auth.workspaceId, imp);

  await auth.db
    .from("imports")
    .update({
      mapping_config: { ...mapping, sheet: stored.sheet } as unknown as Json,
      total_rows: preview.totalRows,
      valid_rows: preview.valid,
      invalid_rows: preview.invalid,
      duplicate_rows: preview.duplicates,
    })
    .eq("id", importId)
    .eq("workspace_id", auth.workspaceId);

  return {
    ...preview,
    creates: {
      categories: [...newCategories.values()].slice(0, 30),
      accounts: [...newAccounts.values()].slice(0, 30),
    },
    sameFile: null,
    connectedSource: connected?.display_name ?? null,
  };
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

/**
 * Writes one confirmed import (inline for small files, from the background task otherwise).
 * Runs with the service role, every statement scoped to the import's workspace. Safe to run
 * again: a retry first removes what a failed attempt left, then imports from the start.
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
    const mapping = financeMappingSchema.parse(stored);
    const { rows } = await loadRows(await workspaceContext(workspaceId), imp, stored.sheet);
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
    const importRows: {
      row: number;
      status: "imported" | "invalid" | "duplicate";
      normalized: unknown;
      errors: unknown;
      txIndex?: number;
    }[] = [];
    const inserts: Record<string, unknown>[] = [];
    for (const r of results) {
      if (!r.ok) {
        importRows.push({ row: r.row, status: "invalid", normalized: null, errors: r.issues });
        continue;
      }
      if (existing.has(r.tx.fingerprint) && !mapping.includeDuplicates) {
        importRows.push({ row: r.row, status: "duplicate", normalized: r.tx, errors: null });
        continue;
      }
      const categoryId = r.tx.category ? await catalog.category(r.tx.category, r.tx.type) : null;
      const accountId = r.tx.account ? await catalog.account(r.tx.account) : null;
      importRows.push({
        row: r.row,
        status: "imported",
        normalized: r.tx,
        errors: null,
        txIndex: inserts.length,
      });
      inserts.push({
        workspace_id: workspaceId,
        transaction_type: r.tx.type,
        amount: r.tx.amount,
        currency: r.tx.currency,
        transaction_date: r.tx.date,
        description: r.tx.description,
        counterparty: r.tx.counterparty,
        account_id: accountId,
        category_id: categoryId,
        subcategory: r.tx.subcategory,
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
      });
    }

    const created = new Map<number, string>();
    for (let i = 0; i < inserts.length; i += 500) {
      const { data, error } = await db
        .from("finance_transactions")
        .insert(inserts.slice(i, i + 500) as never)
        .select("id, import_row_number");
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not write the transactions", { cause: error });
      for (const t of data ?? []) created.set(t.import_row_number!, t.id);
    }
    for (let i = 0; i < importRows.length; i += 500) {
      const { error } = await db.from("import_rows").insert(
        importRows.slice(i, i + 500).map((r) => ({
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
    }

    const counts = {
      imported: created.size,
      invalid: importRows.filter((r) => r.status === "invalid").length,
      duplicates: importRows.filter((r) => r.status === "duplicate").length,
    };
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
        total_rows: importRows.length,
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
    if (imp.file_path) await removeFinanceImport(workspaceId, imp.file_path).catch(() => undefined);
    await db.from("audit_events").insert({
      workspace_id: workspaceId,
      user_id: userId,
      event_type: "finance.import.completed",
      resource_type: "import",
      resource_id: importId,
      origin: "user_ui",
      result: "success",
      metadata: { ...counts, rows: importRows.length, sourceType: imp.source_type },
    });
    logger.info("finance.import.completed", {
      import_id: importId,
      rows: importRows.length,
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
    logger.warn("finance.import.failed", { import_id: importId, code });
    throw error;
  }
}

/** Categories and accounts by name, created (source "import") when the file names new ones. */
async function loadCatalog(db: ReturnType<typeof createAdminClient>, workspaceId: string) {
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
  const categories: CatalogRow[] = cats ?? [];
  const accounts: CatalogRow[] = accts ?? [];
  return {
    async category(name: string, type: TransactionType) {
      const hit = categories.find(
        (c) =>
          norm(c.name) === norm(name) && (c.category_type === type || c.category_type === "both"),
      );
      if (hit) return hit.id;
      const { data, error } = await db
        .from("finance_categories")
        .insert({ workspace_id: workspaceId, name, category_type: type, source: "import" })
        .select("id, name, category_type")
        .single();
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not create a category", { cause: error });
      categories.push(data);
      return data.id;
    },
    async account(name: string) {
      const hit = accounts.find((a) => norm(a.name) === norm(name));
      if (hit) return hit.id;
      const { data, error } = await db
        .from("finance_accounts")
        .insert({ workspace_id: workspaceId, name, source: "import" })
        .select("id, name")
        .single();
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not create an account", { cause: error });
      accounts.push(data);
      return data.id;
    },
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
