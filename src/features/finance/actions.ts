"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { runUserTool } from "@/application/elise";
import {
  cancelFinanceImport,
  confirmFinanceImport,
  importIssues,
  inspectImport,
  prepareFileImport,
  prepareSheetsImport,
  previewFinanceImport,
} from "@/application/finance-import";
import { setFinanceDefaultCurrency } from "@/application/finance-service";
import {
  connectSheet,
  inspectTab,
  openSpreadsheet,
  previewTab,
  recentSpreadsheets,
  removeSource,
  syncSourceNow,
  updateSource,
} from "@/application/finance-sources";
import type { ToolDisplay } from "@/core/agents/tools";
import { AppError, toPublicError, type PublicError } from "@/core/errors";

export type FinanceResult<T = null> = { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<FinanceResult<T>> {
  try {
    const value = await fn();
    revalidatePath("/my-elise/finance", "layout");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

const id = z.uuid();
const FINANCE_TOOL =
  /^finance\.(createTransaction|updateTransaction|archiveTransaction|createAccount|updateAccount|createCategory|undoImport)$/;

/**
 * Finance changes from the UI go through the Finance tools, exactly like Chat: the tool
 * validates the input and the executor applies policy and audit (origin user_ui).
 */
export async function financeToolAction(
  tool: string,
  args: unknown,
  idempotencyKey?: string,
): Promise<FinanceResult<ToolDisplay | undefined>> {
  return run(async () => {
    if (!FINANCE_TOOL.test(tool)) throw new AppError("VALIDATION_ERROR", "Unknown action");
    const auth = await requireAuthContext();
    return (
      await runUserTool(
        auth,
        tool,
        args,
        idempotencyKey ? z.string().max(100).parse(idempotencyKey) : undefined,
      )
    ).display;
  });
}

export async function setDefaultCurrencyAction(currency: string | null) {
  return run(async () =>
    setFinanceDefaultCurrency(
      await requireAuthContext(),
      currency ? z.string().trim().max(10).parse(currency) : null,
    ),
  );
}

// ── Imports ──────────────────────────────────────────────────────────────────

export async function prepareFileImportAction(file: { name: string; size: number; type: string }) {
  return run(async () =>
    prepareFileImport(
      await requireAuthContext(),
      z
        .object({
          name: z.string().trim().min(1).max(300),
          size: z.number().int(),
          type: z.string().max(200),
        })
        .parse(file),
    ),
  );
}

export async function prepareSheetsImportAction(input: {
  connectionId: string;
  spreadsheetId: string;
  sheetId: number;
}) {
  return run(async () =>
    prepareSheetsImport(
      await requireAuthContext(),
      z
        .object({
          connectionId: id,
          spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),
          sheetId: z.number().int().min(0),
        })
        .parse(input),
    ),
  );
}

export async function inspectImportAction(importId: string, sheet?: string) {
  return run(async () =>
    inspectImport(
      await requireAuthContext(),
      id.parse(importId),
      sheet ? z.string().max(200).parse(sheet) : undefined,
    ),
  );
}

export async function previewImportAction(importId: string, mapping: unknown) {
  return run(async () =>
    previewFinanceImport(await requireAuthContext(), id.parse(importId), mapping),
  );
}

export async function confirmImportAction(importId: string) {
  return run(async () => confirmFinanceImport(await requireAuthContext(), id.parse(importId)));
}

export async function cancelImportAction(importId: string) {
  return run(async () => cancelFinanceImport(await requireAuthContext(), id.parse(importId)));
}

export async function importIssuesAction(importId: string) {
  return run(async () => importIssues(await requireAuthContext(), id.parse(importId)));
}

// ── Connected Google Sheets ──────────────────────────────────────────────────

const tabInput = z.object({
  connectionId: id,
  spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),
  sheetId: z.number().int().min(0),
});

export async function recentSpreadsheetsAction(connectionId: string) {
  return run(async () => recentSpreadsheets(await requireAuthContext(), id.parse(connectionId)));
}

export async function openSpreadsheetAction(connectionId: string, link: string) {
  return run(async () =>
    openSpreadsheet(
      await requireAuthContext(),
      id.parse(connectionId),
      z.string().max(500).parse(link),
    ),
  );
}

export async function inspectTabAction(input: z.infer<typeof tabInput>) {
  return run(async () => inspectTab(await requireAuthContext(), tabInput.parse(input)));
}

export async function previewTabAction(input: z.infer<typeof tabInput> & { mapping: unknown }) {
  return run(async () =>
    previewTab(await requireAuthContext(), { ...tabInput.parse(input), mapping: input.mapping }),
  );
}

export async function connectSheetAction(
  input: z.infer<typeof tabInput> & { name: string; mapping: unknown },
) {
  return run(async () =>
    connectSheet(await requireAuthContext(), {
      ...tabInput.parse(input),
      name: z.string().max(200).parse(input.name),
      mapping: input.mapping,
    }),
  );
}

export async function syncSourceAction(sourceId: string) {
  return run(async () => syncSourceNow(await requireAuthContext(), id.parse(sourceId)));
}

export async function updateSourceAction(
  sourceId: string,
  patch: { includeInTotals?: boolean; name?: string },
) {
  return run(async () =>
    updateSource(
      await requireAuthContext(),
      id.parse(sourceId),
      z
        .object({ includeInTotals: z.boolean().optional(), name: z.string().max(200).optional() })
        .parse(patch),
    ),
  );
}

export async function removeSourceAction(sourceId: string) {
  return run(async () => removeSource(await requireAuthContext(), id.parse(sourceId)));
}
