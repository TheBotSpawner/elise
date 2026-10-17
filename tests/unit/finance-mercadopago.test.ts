import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import {
  bodyRows,
  buildFinancePreview,
  detectFormats,
  financeMappingSchema,
  normalizeAll,
  parseCsv,
} from "@/core/finance/import";
import { detectHeaderRow, inferFinanceMapping } from "@/core/finance/inference";
import { parseSpreadsheet } from "@/infrastructure/finance/spreadsheet";

import { mercadoPagoSettlementCsv } from "../fixtures/mercado-pago-settlement";

/**
 * The real Mercado Pago settlement export that couldn't get past the importer (ADR-075):
 * every row was blocked because PAYMENT_METHOD_TYPE was read as the transaction type and the
 * file has no currency column. The same path the import service takes, minus storage.
 */
async function analyze(defaultCurrency: string | null = null) {
  const [sheet] = await parseSpreadsheet(strToU8(mercadoPagoSettlementCsv()), "csv");
  const rows = sheet!.rows;
  const headerRow = detectHeaderRow(rows);
  const headers = rows[headerRow]!;
  const inferred = inferFinanceMapping(
    headers,
    bodyRows(rows, headerRow).map((r) => r.cells),
  );
  const formats = detectFormats(rows, inferred.columns, headerRow);
  const mapping = financeMappingSchema.parse({
    columns: inferred.columns,
    headerRow,
    numberFormat: formats.numberFormat,
    dateFormat: formats.dateFormat,
    defaultCurrency: inferred.currency ?? defaultCurrency,
    defaultType: inferred.defaultType,
    defaultAccount: inferred.account,
  });
  return { rows, headers, inferred, mapping };
}

describe("Mercado Pago settlement CSV", () => {
  it("semicolons are columns, not one giant column; 230 rows", async () => {
    const { headers, rows } = await analyze();
    expect(headers).toHaveLength(12);
    expect(headers[0]).toBe("SOURCE_ID");
    expect(rows.length - 1).toBe(230);
    expect(parseCsv("a;b;c\n1;2;3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("dates and amounts are recognized; PAYMENT_METHOD_TYPE is never the type", async () => {
    const { headers, inferred, mapping } = await analyze();
    const col = (f: keyof typeof mapping.columns) =>
      mapping.columns[f] === undefined ? undefined : headers[mapping.columns[f]!];
    expect(inferred.format).toMatchObject({ id: "mercadopago_settlement", label: "Mercado Pago" });
    expect(col("date")).toBe("TRANSACTION_DATE");
    expect(col("amount")).toBe("TRANSACTION_AMOUNT");
    expect(col("type")).toBeUndefined();
    expect(col("paymentMethod")).toBe("PAYMENT_METHOD_TYPE");
    expect(col("reference")).toBe("SOURCE_ID");
    expect(mapping.defaultType).toBe("sign");
    expect(mapping.defaultAccount).toBe("Mercado Pago");
  });

  it("only the file's currency is asked — once, not per row, never 'all income or all expense'", async () => {
    const { rows, mapping } = await analyze();
    const preview = buildFinancePreview(rows, mapping, new Set());
    expect(preview.needs).toEqual(["defaultCurrency"]);
    expect(preview.willImport).toBe(0);
  });

  it("after choosing ARS every row is importable, with the direction from the sign", async () => {
    const { rows, mapping } = await analyze("ARS");
    const preview = buildFinancePreview(rows, mapping, new Set());
    expect(preview.needs).toEqual([]);
    expect(preview.invalid).toBe(0);
    expect(preview.willImport).toBe(230);
    const txs = normalizeAll(rows, mapping).flatMap((r) => (r.ok ? [r.tx] : []));
    const byRef = (ref: string) => txs.find((t) => t.reference === ref)!;
    // SETTLEMENT +, SETTLEMENT −, CREDIT +, PAYOUTS −: income/expense by sign, never "transfer".
    expect(byRef("90000000001")).toMatchObject({ type: "income", amount: "100000" });
    expect(byRef("90000000002")).toMatchObject({ type: "expense", amount: "17200" });
    expect(byRef("90000000003")).toMatchObject({ type: "income", amount: "2500.5" });
    expect(byRef("90000000004")).toMatchObject({ type: "expense", amount: "50000" });
    // The fee-bearing row is its gross movement once: no fee added on top.
    expect(byRef("90000000005")).toMatchObject({ type: "income", amount: "1000" });
    // A -03:00 timestamp keeps the date as written; every row belongs to the wallet; no category.
    expect(byRef("90000000001")).toMatchObject({
      date: "2026-09-14",
      currency: "ARS",
      account: "Mercado Pago",
      category: null,
      paymentMethod: "available_money",
    });
    expect(txs.some((t) => t.type === "transfer")).toBe(false);
  });

  it("re-reading the same file gives the same fingerprints (imports stay idempotent)", async () => {
    const a = await analyze("ARS");
    const b = await analyze("ARS");
    const prints = (x: typeof a) =>
      normalizeAll(x.rows, x.mapping).flatMap((r) => (r.ok ? [r.tx.fingerprint] : []));
    const first = new Set(prints(a));
    const again = buildFinancePreview(b.rows, b.mapping, first);
    expect(again.willImport).toBe(0);
    expect(again.duplicates).toBe(230);
  });
});

describe("signed amounts in a generic export", () => {
  it("both signs and no type column → the sign decides (no blanket choice)", () => {
    const rows = [
      ["Fecha", "Detalle", "Importe"],
      ["2026-10-01", "Sueldo", "350000.00"],
      ["2026-10-02", "Super", "-25300.50"],
      ["2026-10-03", "Luz", "-8000.00"],
    ];
    const inferred = inferFinanceMapping(rows[0]!, rows.slice(1));
    expect(inferred.defaultType).toBe("sign");
    expect(inferred.columns.type).toBeUndefined();
  });

  it("all-positive amounts don't guess a direction", () => {
    const rows = [
      ["Fecha", "Detalle", "Importe"],
      ["2026-10-01", "Super", "100.00"],
      ["2026-10-02", "Luz", "200.00"],
    ];
    expect(inferFinanceMapping(rows[0]!, rows.slice(1)).defaultType).toBeNull();
  });

  it("a header saying 'type' over non-type values is never the type column", () => {
    const rows = [
      ["Fecha", "Monto", "Payment type"],
      ["2026-10-01", "-100.00", "card"],
      ["2026-10-02", "200.00", "cash"],
    ];
    expect(inferFinanceMapping(rows[0]!, rows.slice(1)).columns.type).toBeUndefined();
  });
});
