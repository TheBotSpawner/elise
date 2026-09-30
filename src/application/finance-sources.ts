import "server-only";

import { AppError, toAppError } from "@/core/errors";
import { suggestMappingWithAI } from "@/core/finance/ai-mapping";
import {
  bodyRows,
  buildFinancePreview,
  detectFormats,
  financeMappingSchema,
  normalizeAll,
  rowKeys,
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
import { logger } from "@/infrastructure/observability/logger";
import { GoogleSheetsClient, parseSpreadsheetId } from "@/infrastructure/providers/google/sheets";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { FinanceSourceRow, Json } from "@/infrastructure/supabase/database.types";

import type { AuthContext } from "./auth-context";
import { workspaceContext } from "./background";
import { googleHttpFor } from "./elise";
import { detectHeaderRow } from "./finance-import";

/**
 * Connected Google Sheets for Finance (docs/architecture/10 §56). The sheet stays the source of
 * truth: ELISE reads it with the connection's read-only Sheets grant, normalizes each row with
 * the user's mapping and keeps a structured mirror (never vectorized, never in AI context)
 * that Finance queries. Sync runs about hourly in the background and on "Sync now".
 */

const SYNC_EVERY_MINUTES = 60;

export interface FinanceGoogleAccount {
  connectionId: string;
  name: string;
  account: string | null;
  /** Sheets allowed on this account (else: enable it in Connections). */
  ready: boolean;
  /** Drive allowed too, so recent spreadsheets can be listed. */
  canBrowse: boolean;
}

export async function financeGoogleAccounts(auth: AuthContext): Promise<FinanceGoogleAccount[]> {
  const [{ data: conns }, { data: caps }] = await Promise.all([
    auth.db
      .from("provider_connections")
      .select("id, display_name, account_label, status")
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "google")
      .eq("status", "connected"),
    auth.db
      .from("connection_capabilities")
      .select("connection_id, capability_key, enabled")
      .eq("workspace_id", auth.workspaceId)
      .in("capability_key", ["finance", "knowledge"]),
  ]);
  const has = (id: string, key: string) =>
    (caps ?? []).some((c) => c.connection_id === id && c.capability_key === key && c.enabled);
  return (conns ?? []).map((c) => ({
    connectionId: c.id,
    name: c.display_name,
    account: c.account_label,
    ready: has(c.id, "finance"),
    canBrowse: has(c.id, "finance") && has(c.id, "knowledge"),
  }));
}

async function sheetsFor(auth: AuthContext, connectionId: string) {
  const account = (await financeGoogleAccounts(auth)).find((a) => a.connectionId === connectionId);
  if (!account) throw new AppError("NOT_FOUND", "Google account not found");
  if (!account.ready) {
    throw new AppError("PERMISSION_DENIED", "Allow Google Sheets for this account in Connections", {
      recovery: "configure",
    });
  }
  return { client: new GoogleSheetsClient(googleHttpFor(auth, connectionId)), account };
}

export async function recentSpreadsheets(auth: AuthContext, connectionId: string) {
  const { client, account } = await sheetsFor(auth, connectionId);
  return account.canBrowse ? client.recent(20) : [];
}

export async function openSpreadsheet(auth: AuthContext, connectionId: string, linkOrId: string) {
  const id = parseSpreadsheetId(linkOrId);
  if (!id)
    throw new AppError("VALIDATION_ERROR", "Paste the spreadsheet's link from Google Sheets", {
      recovery: "review",
    });
  const { client } = await sheetsFor(auth, connectionId);
  return client.spreadsheet(id);
}

export interface TabInspection {
  spreadsheetId: string;
  title: string;
  sheetId: number;
  tab: string;
  headers: string[];
  sample: Cell[][];
  rows: number;
  mapping: FinanceMapping;
  fromAI: FinanceField[];
  /** A completed import of this same tab exists: connecting it would count it twice. */
  alreadyImported: boolean;
  /** This tab is already a connected source. */
  alreadyConnected: string | null;
}

async function readTab(client: GoogleSheetsClient, spreadsheetId: string, sheetId: number) {
  const info = await client.spreadsheet(spreadsheetId);
  const tab = info.tabs.find((t) => t.sheetId === sheetId);
  if (!tab) throw new AppError("NOT_FOUND", "That tab doesn't exist in the spreadsheet");
  return { info, tab, rows: await client.values(spreadsheetId, tab.title) };
}

async function overlap(auth: AuthContext, spreadsheetId: string, sheetId: number) {
  const [{ data: imported }, { data: connected }] = await Promise.all([
    auth.db
      .from("imports")
      .select("id")
      .eq("workspace_id", auth.workspaceId)
      .eq("source_reference", `${spreadsheetId}#${sheetId}`)
      .eq("status", "completed")
      .limit(1),
    auth.db
      .from("finance_sources")
      .select("display_name")
      .eq("workspace_id", auth.workspaceId)
      .eq("spreadsheet_id", spreadsheetId)
      .eq("sheet_id", sheetId)
      .is("archived_at", null)
      .maybeSingle(),
  ]);
  return {
    alreadyImported: Boolean(imported?.length),
    alreadyConnected: connected?.display_name ?? null,
  };
}

export async function inspectTab(
  auth: AuthContext,
  input: { connectionId: string; spreadsheetId: string; sheetId: number },
): Promise<TabInspection> {
  const { client } = await sheetsFor(auth, input.connectionId);
  const { info, tab, rows } = await readTab(client, input.spreadsheetId, input.sheetId);
  if (!rows.length)
    throw new AppError("VALIDATION_ERROR", "That tab is empty", { recovery: "review" });
  const headerRow = detectHeaderRow(rows);
  const headers = rows[headerRow] ?? [];
  const body = bodyRows(rows, headerRow).map((r) => r.cells);
  const ai = (() => {
    try {
      return getAIProvider();
    } catch {
      return null;
    }
  })();
  const suggestion = await suggestMappingWithAI(ai, headers, body.slice(0, 5));
  const formats = detectFormats(rows, suggestion.columns, headerRow);
  return {
    spreadsheetId: info.id,
    title: info.title,
    sheetId: tab.sheetId,
    tab: tab.title,
    headers,
    sample: body.slice(0, 5).map((r) => r.map((c) => c.slice(0, 80))),
    rows: body.length,
    mapping: financeMappingSchema.parse({
      columns: suggestion.columns,
      headerRow,
      numberFormat: formats.numberFormat,
      dateFormat: formats.dateFormat,
    }),
    fromAI: suggestion.fromAI,
    ...(await overlap(auth, info.id, tab.sheetId)),
  };
}

/** What the connected source would contain with this mapping (nothing is saved). */
export async function previewTab(
  auth: AuthContext,
  input: { connectionId: string; spreadsheetId: string; sheetId: number; mapping: unknown },
): Promise<FinancePreview> {
  const { client } = await sheetsFor(auth, input.connectionId);
  const { rows } = await readTab(client, input.spreadsheetId, input.sheetId);
  return buildFinancePreview(rows, financeMappingSchema.parse(input.mapping), new Set());
}

export async function connectSheet(
  auth: AuthContext,
  input: {
    connectionId: string;
    spreadsheetId: string;
    sheetId: number;
    name: string;
    mapping: unknown;
  },
): Promise<string> {
  const { client } = await sheetsFor(auth, input.connectionId);
  const { info, tab } = await readTab(client, input.spreadsheetId, input.sheetId);
  const mapping = financeMappingSchema.parse(input.mapping);
  const { alreadyImported, alreadyConnected } = await overlap(auth, info.id, tab.sheetId);
  if (alreadyConnected)
    throw new AppError("CONFLICT", `This tab is already connected as “${alreadyConnected}”`, {
      recovery: "review",
    });
  const name = input.name.trim().slice(0, 200) || `${info.title} · ${tab.title}`;
  const { data, error } = await auth.db
    .from("finance_sources")
    .insert({
      workspace_id: auth.workspaceId,
      connection_id: input.connectionId,
      display_name: name,
      spreadsheet_id: info.id,
      sheet_id: tab.sheetId,
      sheet_title: tab.title,
      mapping_config: mapping as unknown as Json,
      // Imported already: keep it readable by name, but out of totals by default.
      include_in_totals: !alreadyImported,
      created_by_user_id: auth.userId,
    })
    .select("id")
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", "Could not connect the sheet", { cause: error });
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: "finance.source.connected",
    resource_type: "finance_source",
    resource_id: data.id,
    provider_key: "google",
    connection_id: input.connectionId,
    origin: "user_ui",
    result: "success",
    metadata: { excludedFromTotals: alreadyImported },
  });
  await startFinanceSync(auth.workspaceId, data.id);
  return data.id;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/** Background when available; otherwise inline (bounded by the sheet size limit). */
export async function startFinanceSync(workspaceId: string, sourceId: string) {
  const db = createAdminClient();
  const now = new Date().toISOString();
  const { data: claimed } = await db
    .from("finance_sources")
    .update({ status: "syncing", sync_started_at: now })
    .eq("id", sourceId)
    .eq("workspace_id", workspaceId)
    .is("archived_at", null)
    .neq("status", "syncing")
    .select("id")
    .maybeSingle();
  if (!claimed) return; // already syncing
  if (isBackgroundConfigured()) {
    try {
      const { runtimeJobId } = await new TriggerDevBackgroundRuntime().enqueue({
        type: "finance.sync",
        payload: { workspaceId, sourceId },
        idempotencyKey: `finance-sync:${sourceId}:${now}`,
      });
      await db
        .from("finance_sources")
        .update({ runtime_job_id: runtimeJobId })
        .eq("id", sourceId)
        .eq("workspace_id", workspaceId);
      return;
    } catch (error) {
      logger.warn("finance.sync_enqueue_failed", {
        source_id: sourceId,
        code: toAppError(error).code,
      });
    }
  }
  await runFinanceSync(workspaceId, sourceId).catch(() => undefined);
}

/**
 * One sync of one connected sheet: read every value, normalize with the saved mapping, upsert
 * rows by their stable key, delete rows that disappeared. A failure keeps the last good rows
 * (still labeled with their sync time) and marks the source as needing attention.
 */
export async function runFinanceSync(workspaceId: string, sourceId: string) {
  const db = createAdminClient();
  const started = Date.now();
  const { data: source } = await db
    .from("finance_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("workspace_id", workspaceId)
    .is("archived_at", null)
    .maybeSingle();
  if (!source) return null;
  const fail = async (code: string) => {
    await db
      .from("finance_sources")
      .update({
        status: "needs_attention",
        last_error_code: code,
        next_sync_at: new Date(Date.now() + SYNC_EVERY_MINUTES * 60_000).toISOString(),
        sync_started_at: null,
      })
      .eq("id", sourceId)
      .eq("workspace_id", workspaceId);
    logger.warn("finance.sync_failed", { source_id: sourceId, code });
  };
  if (!source.connection_id) {
    await fail("AUTH_EXPIRED");
    return null;
  }
  // Sheets switched off for this account in Connections: ELISE stops reading it.
  const { data: grant } = await db
    .from("connection_capabilities")
    .select("enabled")
    .eq("connection_id", source.connection_id)
    .eq("capability_key", "finance")
    .maybeSingle();
  if (!grant?.enabled) {
    await fail("PERMISSION_DENIED");
    return null;
  }
  try {
    const auth = await workspaceContext(workspaceId);
    const client = new GoogleSheetsClient(googleHttpFor(auth, source.connection_id));
    const rows = await client.values(source.spreadsheet_id, await currentTitle(client, source));
    const mapping = financeMappingSchema.parse(source.mapping_config);
    const results = normalizeAll(rows, mapping);
    const valid = results.flatMap((r) => (r.ok ? [{ ...r.tx, row: r.row }] : []));
    const keys = rowKeys(valid);
    const records = valid.map((t, i) => ({
      workspace_id: workspaceId,
      source_id: sourceId,
      row_key: keys[i]!,
      row_number: t.row,
      transaction_type: t.type,
      amount: t.amount,
      currency: t.currency,
      transaction_date: t.date,
      description: t.description,
      counterparty: t.counterparty,
      account_name: t.account,
      category_name: t.category,
      subcategory: t.subcategory,
      payment_method: t.paymentMethod,
      project: t.project,
      status: t.status,
      notes: t.notes,
      fingerprint: t.fingerprint,
    }));
    for (let i = 0; i < records.length; i += 500) {
      const { error } = await db
        .from("finance_source_rows")
        .upsert(records.slice(i, i + 500), { onConflict: "source_id,row_key" });
      if (error)
        throw new AppError("INTERNAL_ERROR", "Could not store the sheet rows", { cause: error });
    }
    // Rows no longer in the sheet leave ELISE too.
    const current = new Set(keys);
    const stale: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data } = await db
        .from("finance_source_rows")
        .select("id, row_key")
        .eq("workspace_id", workspaceId)
        .eq("source_id", sourceId)
        .range(offset, offset + 999);
      for (const r of data ?? []) if (!current.has(r.row_key)) stale.push(r.id);
      if ((data ?? []).length < 1000) break;
    }
    for (let i = 0; i < stale.length; i += 200) {
      await db
        .from("finance_source_rows")
        .delete()
        .eq("workspace_id", workspaceId)
        .in("id", stale.slice(i, i + 200));
    }
    const now = new Date();
    await db
      .from("finance_sources")
      .update({
        status: "ready",
        row_count: valid.length,
        invalid_rows: results.length - valid.length,
        last_synced_at: now.toISOString(),
        last_error_code: null,
        next_sync_at: new Date(now.getTime() + SYNC_EVERY_MINUTES * 60_000).toISOString(),
        sync_started_at: null,
      })
      .eq("id", sourceId)
      .eq("workspace_id", workspaceId);
    const counts = {
      rows: valid.length,
      invalid: results.length - valid.length,
      removed: stale.length,
    };
    logger.info("finance.sync_completed", {
      source_id: sourceId,
      ...counts,
      ms: Date.now() - started,
    });
    return counts;
  } catch (error) {
    await fail(toAppError(error).code);
    throw error;
  }
}

/** Tabs can be renamed in Sheets: follow the tab by id and remember its new title. */
async function currentTitle(client: GoogleSheetsClient, source: FinanceSourceRow) {
  const info = await client.spreadsheet(source.spreadsheet_id);
  const tab = info.tabs.find((t) => t.sheetId === source.sheet_id);
  if (!tab) throw new AppError("NOT_FOUND", "The tab was deleted from the spreadsheet");
  if (tab.title !== source.sheet_title) {
    await createAdminClient()
      .from("finance_sources")
      .update({ sheet_title: tab.title })
      .eq("id", source.id)
      .eq("workspace_id", source.workspace_id);
  }
  return tab.title;
}

/** Periodic tick: release stuck syncs, then start the ones that are due. */
export async function dispatchFinanceSyncs(): Promise<{ started: number }> {
  const db = createAdminClient();
  const now = new Date();
  await db
    .from("finance_sources")
    .update({ status: "needs_attention", last_error_code: "TIMEOUT", sync_started_at: null })
    .eq("status", "syncing")
    .lt("sync_started_at", new Date(now.getTime() - 30 * 60_000).toISOString());
  const { data } = await db
    .from("finance_sources")
    .select("id, workspace_id")
    .is("archived_at", null)
    .neq("status", "syncing")
    .neq("status", "disconnected")
    .lte("next_sync_at", now.toISOString())
    .limit(50);
  let started = 0;
  for (const s of data ?? []) {
    await startFinanceSync(s.workspace_id, s.id).catch(() => undefined);
    started++;
  }
  return { started };
}

// ── Management ───────────────────────────────────────────────────────────────

async function ownSource(auth: AuthContext, sourceId: string) {
  const { data } = await auth.db
    .from("finance_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("workspace_id", auth.workspaceId)
    .is("archived_at", null)
    .maybeSingle();
  if (!data) throw new AppError("NOT_FOUND", "Source not found");
  return data;
}

export async function syncSourceNow(auth: AuthContext, sourceId: string) {
  await ownSource(auth, sourceId);
  await startFinanceSync(auth.workspaceId, sourceId);
}

export async function updateSource(
  auth: AuthContext,
  sourceId: string,
  patch: { includeInTotals?: boolean; name?: string },
) {
  await ownSource(auth, sourceId);
  const { error } = await auth.db
    .from("finance_sources")
    .update({
      ...(patch.includeInTotals !== undefined ? { include_in_totals: patch.includeInTotals } : {}),
      ...(patch.name?.trim() ? { display_name: patch.name.trim().slice(0, 200) } : {}),
    })
    .eq("id", sourceId)
    .eq("workspace_id", auth.workspaceId);
  if (error)
    throw new AppError("VALIDATION_ERROR", "Could not update the source", { cause: error });
}

/** Disconnect one sheet: its mirrored rows are deleted; nothing changes in the sheet. */
export async function removeSource(auth: AuthContext, sourceId: string) {
  await ownSource(auth, sourceId);
  await purgeFinanceSources(auth.workspaceId, [sourceId], "archived");
  await auth.db.from("audit_events").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    event_type: "finance.source.removed",
    resource_type: "finance_source",
    resource_id: sourceId,
    origin: "user_ui",
    result: "success",
    metadata: {},
  });
}

async function purgeFinanceSources(
  workspaceId: string,
  ids: string[],
  status: "archived" | "disconnected",
) {
  if (!ids.length) return;
  const db = createAdminClient();
  await db
    .from("finance_source_rows")
    .delete()
    .eq("workspace_id", workspaceId)
    .in("source_id", ids);
  await db
    .from("finance_sources")
    .update({
      status,
      row_count: 0,
      ...(status === "archived" ? { archived_at: new Date().toISOString() } : {}),
    })
    .eq("workspace_id", workspaceId)
    .in("id", ids);
}

/** A Google account was disconnected: its sheets stop syncing and their rows leave ELISE. */
export async function purgeConnectionFinance(workspaceId: string, connectionId: string) {
  const { data } = await createAdminClient()
    .from("finance_sources")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .is("archived_at", null);
  await purgeFinanceSources(
    workspaceId,
    (data ?? []).map((s) => s.id),
    "disconnected",
  );
}

export interface FinanceSourceView {
  id: string;
  name: string;
  spreadsheetTitle: string;
  tab: string;
  account: string | null;
  status: FinanceSourceRow["status"];
  includeInTotals: boolean;
  rows: number;
  invalidRows: number;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  url: string;
}

export async function listFinanceSources(auth: AuthContext): Promise<FinanceSourceView[]> {
  const [{ data }, { data: conns }] = await Promise.all([
    auth.db
      .from("finance_sources")
      .select("*")
      .eq("workspace_id", auth.workspaceId)
      .is("archived_at", null)
      .order("created_at"),
    auth.db
      .from("provider_connections")
      .select("id, display_name")
      .eq("workspace_id", auth.workspaceId)
      .eq("provider_key", "google"),
  ]);
  return (data ?? []).map((s) => ({
    id: s.id,
    name: s.display_name,
    spreadsheetTitle: s.display_name,
    tab: s.sheet_title,
    account: (conns ?? []).find((c) => c.id === s.connection_id)?.display_name ?? null,
    status: s.status,
    includeInTotals: s.include_in_totals,
    rows: s.row_count,
    invalidRows: s.invalid_rows,
    lastSyncedAt: s.last_synced_at,
    lastErrorCode: s.last_error_code,
    url: `https://docs.google.com/spreadsheets/d/${s.spreadsheet_id}/edit#gid=${s.sheet_id}`,
  }));
}
