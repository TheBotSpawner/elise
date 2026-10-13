import { describe, expect, it } from "vitest";

import {
  budgetUsage,
  cleanCategoryName,
  computeTotals,
  convertTotals,
  matchesFilter,
  trendFromGroups,
  trendSeries,
  UNCLASSIFIED,
  type Budget,
  type FinanceTransaction,
} from "@/core/capabilities/finance";
import {
  buildFinancePreview,
  financeMappingSchema,
  normalizeRow,
  parseCsv,
  suggestFinanceMapping,
} from "@/core/finance/import";
import { multiplyByRate, shareTenths } from "@/core/finance/money";
import { buildFinanceReport, monthsIn } from "@/core/finance/report";
import { shiftPeriod } from "@/core/periods";

let seq = 0;
function tx(
  t: Partial<FinanceTransaction> &
    Pick<FinanceTransaction, "amount" | "currency" | "date" | "type">,
): FinanceTransaction {
  return {
    id: `t${++seq}`,
    description: null,
    counterparty: null,
    category: null,
    categoryId: null,
    categoryPath: t.category ? [t.category] : [],
    subcategory: null,
    account: null,
    accountId: null,
    paymentMethod: null,
    project: null,
    status: "completed",
    notes: null,
    importId: null,
    bookId: null,
    book: null,
    readOnly: false,
    fingerprint: "",
    provenance: { source: "ELISE Finance", connectionId: "n", row: null },
    updatedAt: "2026-10-01T00:00:00Z",
    ...t,
  } as FinanceTransaction;
}

const PERIOD = { from: "2026-09-01", to: "2026-09-30" };

describe("Finance v2 (ADR-052)", () => {
  it("transfers are neither income nor expense", () => {
    const rows = [
      tx({ type: "income", amount: "1000", currency: "ARS", date: "2026-09-02" }),
      tx({ type: "expense", amount: "300", currency: "ARS", date: "2026-09-03" }),
      tx({ type: "transfer", amount: "500", currency: "ARS", date: "2026-09-04" }),
    ];
    const totals = computeTotals(rows, PERIOD);
    expect(totals.totals).toEqual([
      expect.objectContaining({ currency: "ARS", income: "1000", expense: "300", net: "700" }),
    ]);
    expect(totals.transfers).toBe(1);
  });

  it("filters by Book id and by Sin clasificar", () => {
    const a = tx({
      type: "expense",
      amount: "1",
      currency: "ARS",
      date: "2026-09-02",
      bookId: "b1",
      book: "Firbot",
    });
    const b = tx({ type: "expense", amount: "1", currency: "ARS", date: "2026-09-02" });
    expect(matchesFilter(a, { ...PERIOD, book: "b1" })).toBe(true);
    expect(matchesFilter(a, { ...PERIOD, book: "firbot" })).toBe(true);
    expect(matchesFilter(b, { ...PERIOD, book: "b1" })).toBe(false);
    expect(matchesFilter(b, { ...PERIOD, book: UNCLASSIFIED })).toBe(true);
    expect(matchesFilter(a, { ...PERIOD, book: UNCLASSIFIED })).toBe(false);
  });

  it("converts each transaction at its own dated rate and never guesses a missing one", () => {
    const rows = [
      tx({ type: "expense", amount: "10", currency: "USD", date: "2026-09-02" }),
      tx({ type: "expense", amount: "10", currency: "USD", date: "2026-09-20" }),
      tx({ type: "income", amount: "5000", currency: "ARS", date: "2026-09-05" }),
      tx({ type: "expense", amount: "3", currency: "NZD", date: "2026-09-05" }),
    ];
    const rates = [
      { from: "USD", to: "ARS", rate: "1000", date: "2026-09-01" },
      { from: "USD", to: "ARS", rate: "1200", date: "2026-09-15" },
    ];
    const c = convertTotals(rows, PERIOD, "ARS", rates);
    expect(c.expense).toBe("22000");
    expect(c.income).toBe("5000");
    expect(c.net).toBe("-17000");
    expect(c.ratesUsed.map((r) => r.rate)).toEqual(["1000", "1200"]);
    expect(c.unconverted).toEqual([{ currency: "NZD", count: 1 }]);
    // Inverse direction uses the same rate.
    const back = convertTotals([rows[2]!], PERIOD, "USD", rates);
    expect(back.income).toBe("5");
  });

  it("budgets: 80% is close, 100% is over; other currencies and pending don't count", () => {
    const budget: Budget = {
      id: "bu",
      bookId: null,
      book: null,
      categoryId: "c-pub",
      category: "Publicidad",
      subcategory: null,
      currency: "ARS",
      amount: "100000",
    };
    const spend = (amount: string, extra: Partial<FinanceTransaction> = {}) =>
      tx({
        type: "expense",
        amount,
        currency: "ARS",
        date: "2026-09-10",
        categoryId: "c-pub",
        category: "Publicidad",
        ...extra,
      });
    expect(budgetUsage(budget, [spend("79999")]).state).toBe("ok");
    const near = budgetUsage(budget, [
      spend("80000"),
      spend("5", { currency: "USD" }),
      spend("1", { status: "pending" }),
    ]);
    expect(near).toMatchObject({
      state: "warning",
      percentTenths: 800,
      otherCurrencies: 1,
      pending: 1,
      remaining: "20000",
    });
    const over = budgetUsage(budget, [spend("100000"), spend("500")]);
    expect(over).toMatchObject({ state: "over", remaining: "-500" });
  });

  it("trend series per currency, and the same series from query groups", () => {
    const rows = [
      tx({ type: "income", amount: "100", currency: "ARS", date: "2026-07-03" }),
      tx({ type: "expense", amount: "40", currency: "ARS", date: "2026-09-03" }),
      tx({ type: "expense", amount: "7", currency: "USD", date: "2026-09-03" }),
    ];
    const p = { from: "2026-07-01", to: "2026-09-30" };
    const series = trendSeries(rows, p, "month");
    const ars = series.find((s) => s.currency === "ARS")!;
    expect(ars.keys).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(ars.income).toEqual(["100", "0", "0"]);
    expect(ars.net).toEqual(["100", "0", "-40"]);
    const fromGroups = trendFromGroups(
      [
        { key: "2026-07", type: "income", currency: "ARS", total: "100", count: 1 },
        { key: "2026-09", type: "expense", currency: "ARS", total: "40", count: 1 },
      ],
      p,
      "month",
    );
    expect(fromGroups[0]).toEqual(ars);
  });

  it("‹ › moves whole months as months and other ranges by their length", () => {
    expect(shiftPeriod({ from: "2026-09-01", to: "2026-09-30" }, 1)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(shiftPeriod({ from: "2026-01-01", to: "2026-01-31" }, -1)).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(shiftPeriod({ from: "2026-07-01", to: "2026-09-30" }, 1)).toEqual({
      from: "2026-10-01",
      to: "2026-12-31",
    });
    expect(shiftPeriod({ from: "2026-09-13", to: "2026-10-12" }, 1)).toEqual({
      from: "2026-10-13",
      to: "2026-11-11",
    });
    expect(shiftPeriod({ from: "2026-09-13", to: "2026-10-12" }, -1)).toEqual({
      from: "2026-08-14",
      to: "2026-09-12",
    });
  });

  it("money helpers stay exact", () => {
    expect(multiplyByRate("19.99", "1450.5")).toBe("28995.495");
    expect(shareTenths("823", "1000")).toBe(823);
    expect(cleanCategoryName("Gastos - Herramientas")).toBe("Herramientas");
    expect(cleanCategoryName("Ingresos: Servicios")).toBe("Servicios");
    expect(cleanCategoryName("Gastos")).toBe("Gastos");
  });

  it("report: same dataset rules, per currency, budgets scaled by months", () => {
    const rows = [
      tx({
        type: "income",
        amount: "2330.83",
        currency: "NZD",
        date: "2026-09-07",
        counterparty: "RSFA",
        category: "Servicios",
      }),
      tx({
        type: "expense",
        amount: "31135.94",
        currency: "ARS",
        date: "2026-09-05",
        counterparty: "OpenAI",
        category: "Herramientas",
        categoryId: "c-h",
      }),
      tx({
        type: "expense",
        amount: "11.94",
        currency: "NZD",
        date: "2026-09-07",
        counterparty: "Microsoft",
        category: "Herramientas",
        categoryId: "c-h",
      }),
      tx({
        type: "expense",
        amount: "1000",
        currency: "ARS",
        date: "2026-09-10",
        status: "pending",
        counterparty: "Meta",
      }),
      tx({ type: "transfer", amount: "500", currency: "ARS", date: "2026-09-11" }),
    ];
    const report = buildFinanceReport({
      rows,
      filter: { ...PERIOD },
      sections: ["summary", "categories", "transactions", "budgets"],
      book: null,
      budgets: [
        {
          id: "b",
          bookId: null,
          book: null,
          categoryId: "c-h",
          category: "Herramientas",
          subcategory: null,
          currency: "ARS",
          amount: "20000",
        },
      ],
      rates: [],
      reportingCurrency: null,
      sources: [],
      truncated: false,
    });
    expect(report.totals.map((c) => c.currency).sort()).toEqual(["ARS", "NZD"]);
    expect(report.expenseCategories.map((g) => `${g.currency}:${g.key}`).sort()).toEqual([
      "ARS:Herramientas",
      "NZD:Herramientas",
    ]);
    expect(report.clients).toEqual([expect.objectContaining({ key: "RSFA", currency: "NZD" })]);
    expect(report.transfers).toBe(1);
    expect(report.excluded.pending).toBe(1);
    // Pending rows are listed (they're real), dated ascending.
    expect(report.transactions.map((t) => t.date)).toEqual([
      "2026-09-05",
      "2026-09-07",
      "2026-09-07",
      "2026-09-10",
      "2026-09-11",
    ]);
    expect(report.budgets[0]).toMatchObject({ spent: "31135.94", state: "over" });
    expect(monthsIn({ from: "2026-08-15", to: "2026-10-02" })).toEqual([
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
  });

  it("imports the Firbot workbook's Movimientos layout", () => {
    const csv = [
      "Fecha,Tipo,Monto (positivo),Monto neto,Moneda,Medio,Categoría,Subcategoría,Cliente/Proveedor,Producto/Proyecto,Estado,Comprobante (link/id),Notas,Mes (inicio),Año,Semana,Ámbito",
      '05/01/2026,Gasto,"31.135,94","-31.135,94",ARS,MercadoPago,Gastos - Herramientas,ChatGPT,OpenAI,,Pagado,FAC-1,,01/01/2026,2026,1,Firbot',
      '07/01/2026,Ingreso,"2.330,83","2.330,83",NZD,KiwiBank,Ingresos - Servicios de Automatización,,Real Savvy Financial Advice,Servicios de Automatizacion,Cobrado,,,01/01/2026,2026,2,',
      '08/01/2026,Transferencia,"500,00","0",ARS,MercadoPago,,,,,Pagado,,,01/01/2026,2026,2,',
    ].join("\n");
    const rows = parseCsv(csv);
    const columns = suggestFinanceMapping(rows[0]!);
    expect(columns).toMatchObject({
      date: 0,
      type: 1,
      amount: 2,
      currency: 4,
      account: 5,
      category: 6,
      subcategory: 7,
      counterparty: 8,
      project: 9,
      status: 10,
      reference: 11,
      notes: 12,
      book: 16,
    });
    const mapping = financeMappingSchema.parse({
      columns,
      numberFormat: "comma_decimal",
      dateFormat: "dmy",
    });
    const first = normalizeRow(rows[1]!, mapping, 2);
    expect(first.ok && first.tx).toMatchObject({
      type: "expense",
      amount: "31135.94",
      currency: "ARS",
      date: "2026-01-05",
      category: "Herramientas",
      subcategory: "ChatGPT",
      account: "MercadoPago",
      reference: "FAC-1",
      book: "Firbot",
      status: "completed",
    });
    const preview = buildFinancePreview(
      rows,
      mapping,
      new Set([first.ok ? first.tx.fingerprint : ""]),
    );
    expect(preview).toMatchObject({ valid: 3, duplicates: 1, willImport: 2 });
    // The transfer is imported but adds to neither side.
    expect(preview.byCurrency).toEqual([
      { currency: "NZD", income: "2330.83", expense: "0", incomeCount: 1, expenseCount: 0 },
    ]);
  });
});

describe("Finance v2.1 (ADR-054)", () => {
  it("Día / Semana / Mes / Año around an anchor, ‹ › keeps the span", async () => {
    const { parseFinanceFilters, periodOfFilters, spanOf } =
      await import("@/application/finance-service");
    expect(spanOf("day", "2026-10-13")).toEqual({ from: "2026-10-13", to: "2026-10-13" });
    expect(spanOf("week", "2026-10-15")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(spanOf("month", "2026-10-15")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(spanOf("year", "2026-10-15")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    // Default: Movimientos, all Books, current month.
    const def = parseFinanceFilters({});
    expect(def).toMatchObject({ tab: "movements", gran: "month", period: "span" });
    expect(def.book).toBeUndefined();
    expect(periodOfFilters(def, "2026-10-13")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    const prevYear = parseFinanceFilters({ gran: "year", date: "2025-01-01" });
    expect(periodOfFilters(prevYear, "2026-10-13")).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
    // Chat links with a preset and explicit ranges still work.
    expect(periodOfFilters(parseFinanceFilters({ period: "last_month" }), "2026-10-13")).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(
      periodOfFilters(parseFinanceFilters({ from: "2026-09-01", to: "2026-10-12" }), "2026-10-13"),
    ).toEqual({ from: "2026-09-01", to: "2026-10-12" });
  });

  it("category icons: suggested from the name until the user picks one", async () => {
    const { suggestCategoryIcon } = await import("@/core/capabilities/finance");
    expect(suggestCategoryIcon("Supermercado")).toBe("🛒");
    expect(suggestCategoryIcon("Software")).toBe("💻");
    expect(suggestCategoryIcon("Publicidad/Marketing")).toBe("📣");
    expect(suggestCategoryIcon("Impuestos")).toBe("🧾");
    expect(suggestCategoryIcon("Zzz")).toBeNull();
  });
});
