import { strToU8, Zip, ZipDeflate, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { normalizeType, transferDirection } from "@/core/capabilities/finance";
import {
  bodyRows,
  buildFinancePreview,
  financeMappingSchema,
  normalizeAll,
  parseCsv,
  parseDate,
  type Cell,
} from "@/core/finance/import";
import {
  detectHeaderRow,
  inferDateFormat,
  inferFinanceMapping,
  pickTransactionSheet,
} from "@/core/finance/inference";
import { displayName, entityKey, resolveName } from "@/core/finance/resolve";
import { parseSpreadsheet } from "@/infrastructure/finance/spreadsheet";

/**
 * Finance migration (ADR-073): files from other apps, banks and personal trackers are
 * understood from their values, not only their headers. Synthetic data only.
 */

/** Headers + body → the mapping ELISE infers, ready for the preview. */
function infer(rows: Cell[][]) {
  const header = detectHeaderRow(rows);
  const body = bodyRows(rows, header).map((b) => b.cells);
  const inferred = inferFinanceMapping(rows[header]!, body);
  const mapping = financeMappingSchema.parse({
    columns: inferred.columns,
    headerRow: header,
    defaultCurrency: inferred.currency,
    dateFormat: inferDateFormat(body, inferred.columns.date),
  });
  return { header, inferred, mapping, results: normalizeAll(rows, mapping) };
}

const ok = (results: ReturnType<typeof normalizeAll>) =>
  results.flatMap((r) => (r.ok ? [r.tx] : []));

describe("schema inference across formats", () => {
  it("A. an ELISE-like export maps directly", () => {
    const rows = parseCsv(
      "Date,Account,Category,Description,Amount,Currency,Type\n2026-03-01,Cash,Food,Lunch,12.50,USD,Expense\n2026-03-02,Bank,Salary,March,2000,USD,Income",
    );
    const { inferred, results } = infer(rows);
    expect(inferred.columns).toMatchObject({
      date: 0,
      account: 1,
      category: 2,
      description: 3,
      amount: 4,
      currency: 5,
      type: 6,
    });
    expect(ok(results).map((t) => [t.type, t.amount])).toEqual([
      ["expense", "12.5"],
      ["income", "2000"],
    ]);
  });

  it("B. Spanish headers reach the same result", () => {
    const rows = parseCsv(
      "Fecha;Cuenta;Categoría;Concepto;Monto;Moneda;Tipo\n01/03/2026;Efectivo;Comida;Almuerzo;12,50;USD;Gasto\n15/03/2026;Banco;Sueldo;Marzo;2000;USD;Ingreso",
    );
    const { mapping } = infer(rows);
    const results = normalizeAll(rows, { ...mapping, numberFormat: "comma_decimal" });
    expect(ok(results).map((t) => [t.date, t.type, t.amount, t.account])).toEqual([
      ["2026-03-01", "expense", "12.5", "Efectivo"],
      ["2026-03-15", "income", "2000", "Banco"],
    ]);
  });

  it("C. separate debit and credit columns give the amount and its direction", () => {
    const rows = parseCsv(
      "Fecha,Cuenta,Débito,Crédito,Detalle\n2026-04-01,Banco,2500,,Supermercado\n2026-04-02,Banco,,10000,Transferencia recibida",
    );
    const { inferred, mapping } = infer(rows);
    expect(inferred.columns).toMatchObject({ expenseAmount: 2, incomeAmount: 3, description: 4 });
    const results = normalizeAll(rows, { ...mapping, defaultCurrency: "ARS" });
    expect(ok(results).map((t) => [t.type, t.amount])).toEqual([
      ["expense", "2500"],
      ["income", "10000"],
    ]);
  });

  it("D. a signed amount says expense with its sign", () => {
    const rows = parseCsv(
      "Date,Account,Amount,Memo\n2026-05-01,Card,-2500,Coffee\n2026-05-02,Card,10000,Refund",
    );
    const { mapping } = infer(rows);
    const results = normalizeAll(rows, {
      ...mapping,
      defaultCurrency: "USD",
      defaultType: "income",
    });
    expect(ok(results).map((t) => [t.type, t.amount])).toEqual([
      ["expense", "2500"],
      ["income", "10000"],
    ]);
  });

  it("E. the header is found below a title and export notes", () => {
    const rows = parseCsv(
      "Movimientos exportados\nGenerado el 2026-06-01\n\nFecha,Cuenta,Monto,Moneda,Detalle\n2026-05-30,Banco,100,ARS,Kiosco",
    );
    const { header, mapping } = infer(rows);
    expect(rows[header]![0]).toBe("Fecha");
    // No type and no sign: the preview asks which direction (defaultType); then it reads.
    expect(ok(normalizeAll(rows, { ...mapping, defaultType: "expense" }))).toHaveLength(1);
  });

  it("F. the sheet with the transactions is chosen over a dashboard", () => {
    const dashboard = {
      name: "Dashboard",
      rows: [
        ["Total", "1200"],
        ["Mes", "Marzo"],
      ],
    };
    const data = {
      name: "Movimientos",
      rows: parseCsv("Fecha,Monto,Detalle\n2026-03-01,100,A\n2026-03-02,200,B"),
    };
    expect(pickTransactionSheet([dashboard, data])?.name).toBe("Movimientos");
  });

  it("dates with a time of day and spreadsheet serials are read; ambiguous ones are not guessed", () => {
    expect(parseDate("31/07/2026 19:41:00", null)).toBe("2026-07-31");
    // Day and month both ≤ 12: decided from the column's other dates (dateFormat), never alone.
    expect(parseDate("11/08/2026 22:26:48", null)).toBeNull();
    expect(parseDate("11/08/2026 22:26", "dmy")).toBe("2026-08-11");
    expect(parseDate("2026-08-11T22:26:48Z", null)).toBe("2026-08-11");
    expect(parseDate("46245.93", null)).toBe("2026-08-11");
    expect(parseDate("03/04/2026", null)).toBeNull();
  });

  it("transaction types in several languages, transfers with their direction", () => {
    expect(normalizeType("Transfer-Out")).toBe("transfer");
    expect(transferDirection("Transfer-Out")).toBe("out");
    expect(transferDirection("Transfer-In")).toBe("in");
    expect(normalizeType("Traspaso")).toBe("transfer");
    expect(normalizeType("Deposit")).toBe("income");
    expect(normalizeType("Purchase")).toBe("expense");
  });
});

// ── The export that used to fail: a phone money-manager app ──────────────────

const MM_HEADER = [
  "Date",
  "Account",
  "Category",
  "Subcategory",
  "Note",
  "ARS",
  "Income/Expense",
  "Description",
  "Amount",
  "Currency",
  "Account",
];
const mm = (
  date: string,
  account: string,
  category: string,
  note: string,
  amount: string,
  type: string,
  description = "",
) => [date, account, category, "", note, amount, type, description, amount, "ARS", amount];

const MM_ROWS: Cell[][] = [
  MM_HEADER,
  mm("2026-08-11", "Mercado Pago", "🍜 Food", "Delivery", "18498.0", "Expense"),
  mm("2026-08-11", "Cash", "Gifts", "Regalo cumpleaños", "91000.0", "Income"),
  mm("2026-08-10", "NaranjaX", "Other", "Ajuste", "9842.0", "Income", "12"),
  mm("2026-08-10", "BNA", "Mercado Pago", "Transferencia", "20000.0", "Transfer-Out"),
  mm("2026-08-07", "Mercado Pago", "🚗 Car", "Nafta", "96027.0", "Expense"),
  mm("2026-08-07", "Mercado Pago", "🍜 Food", "Almuerzo", "12000.0", "Expense"),
];

describe("the money-manager export (regression)", () => {
  it("reads the right columns: the text account, the note, one amount, ARS", () => {
    const { inferred, mapping } = infer(MM_ROWS);
    expect(inferred.columns).toMatchObject({
      date: 0,
      account: 1, // the text column, not the numeric second "Account"
      category: 2,
      description: 4, // "Note" describes every row; "Description" is almost empty
      amount: 8,
      type: 6,
      currency: 9,
    });
    // "ARS" and the second "Account" repeat the amount: read once, never twice.
    expect(inferred.ignored.filter((i) => i.reason === "duplicate").map((i) => i.index)).toEqual([
      5, 10,
    ]);
    const preview = buildFinancePreview(MM_ROWS, mapping, new Set());
    expect(preview).toMatchObject({ valid: 6, invalid: 0 });
    expect(preview.byCurrency).toEqual([
      expect.objectContaining({ currency: "ARS", expense: "126525", income: "100842" }),
    ]);
  });

  it("a Transfer-Out moves money between two accounts: no fake expense, no category", () => {
    const transfer = ok(infer(MM_ROWS).results).find((t) => t.type === "transfer")!;
    expect(transfer).toMatchObject({ account: "BNA", toAccount: "Mercado Pago", category: null });
  });

  it("the same names with or without emoji are one category", () => {
    expect(entityKey("🍜 Food")).toBe("food");
    expect(entityKey(" Food")).toBe("food"); // what a broken reader left behind
    expect(displayName("🚗 Car")).toBe("Car");
  });

  it("the phone app's streamed zip with emoji references opens, emoji intact", async () => {
    const [sheet] = await parseSpreadsheet(await streamedXlsx(), "xlsx");
    expect(sheet!.rows[0]).toEqual(["Date", "Category", "Amount"]);
    expect(sheet!.rows[1]).toEqual(["2026-08-11", "🍜 Food", "18498.0"]);
  });

  it("a password-protected workbook is refused with a clear reason", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(parseSpreadsheet(ole, "xlsx")).rejects.toThrow(/password-protected/);
  });
});

describe("accounts and categories: one decision per name", () => {
  const accounts = [
    { id: "a1", name: "Efectivo" },
    { id: "a2", name: "Mercado Pago" },
  ];

  it("Cash is the user's Efectivo; no duplicate account", () => {
    expect(resolveName("Cash", accounts)).toMatchObject({ how: "synonym", id: "a1" });
    expect(resolveName("MercadoPago", accounts)).toMatchObject({ id: "a2" });
  });

  it("an unknown bank is created (nothing deterministic matches)", () => {
    expect(resolveName("Banco Galicia", accounts)).toBeNull();
  });

  it("'Banco' could be two banks: the user decides", () => {
    const banks = [
      { id: "b1", name: "Banco Nación" },
      { id: "b2", name: "Banco Galicia" },
    ];
    expect(resolveName("Banco", banks)).toMatchObject({ how: "review" });
    expect(resolveName("Banco", banks)?.candidates).toHaveLength(2);
    // Specific enough to be sure.
    expect(resolveName("BNA", banks)).toMatchObject({ how: "synonym", id: "b1" });
  });

  it("Food, Transport, Entertainment land on the user's Spanish categories", () => {
    const categories = [
      { id: "c1", name: "Comida" },
      { id: "c2", name: "Transporte" },
      { id: "c3", name: "Entretenimiento" },
    ];
    expect(
      ["🍜 Food", "Transport", "Entertainment"].map((n) => resolveName(n, categories)?.id),
    ).toEqual(["c1", "c2", "c3"]);
  });

  it("the user's own past decision wins over a new guess", () => {
    expect(resolveName("Billetera", accounts, { billetera: "a1" })).toMatchObject({
      how: "alias",
      id: "a1",
    });
  });
});

/** A minimal workbook written the way phone apps do: streamed zip, emoji as references. */
async function streamedXlsx(): Promise<Uint8Array> {
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Money Manager" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5"><si><t>Date</t></si><si><t>Category</t></si><si><t>Amount</t></si><si><t xml:space="preserve">&#x1f35c; Food</t></si><si><t>2026-08-11</t></si></sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>3</v></c><c r="C2" t="str"><v>18498.0</v></c></row></sheetData></worksheet>`,
  };
  const chunks: Uint8Array[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const zip = new Zip((err, data, final) => {
      if (err) return reject(err);
      chunks.push(data);
      if (final) resolve();
    });
    for (const [name, text] of Object.entries(files)) {
      const entry = new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      entry.push(strToU8(text), true);
    }
    zip.end();
  });
  await done;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  void zipSync; // the standard writer is what normalizeXlsx turns this into
  return out;
}
