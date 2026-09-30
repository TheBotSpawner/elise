import { z } from "zod";

import {
  detectNumberFormat,
  normalizeCurrency,
  parseAmount,
  toUnits,
  fromUnits,
  type NumberFormat,
} from "./money";
import {
  fingerprint,
  norm,
  normalizeStatus,
  normalizeType,
  type TransactionStatus,
  type TransactionType,
} from "../capabilities/finance";
import { isIsoDate } from "../time";

/**
 * Finance import (docs/architecture/10 §37-43): inspect columns → suggest a mapping (rules,
 * then AI for what rules missed) → the user confirms → every row is validated by this code →
 * only valid rows are written; invalid rows are shown with their reason, never hidden.
 * The same normalization feeds connected Google Sheets, so a row means the same everywhere.
 */

/** Every cell reaches Core as text (numbers keep their exact digits; dates are ISO). */
export type Cell = string;

export const FINANCE_FIELDS = [
  "date",
  "type",
  "amount",
  "incomeAmount",
  "expenseAmount",
  "currency",
  "description",
  "counterparty",
  "category",
  "subcategory",
  "account",
  "paymentMethod",
  "project",
  "status",
  "notes",
  "reference",
] as const;
export type FinanceField = (typeof FINANCE_FIELDS)[number];

const SYNONYMS: Record<FinanceField, string[]> = {
  date: [
    "date",
    "fecha",
    "dia",
    "día",
    "transaction date",
    "fecha de pago",
    "fecha operacion",
    "fecha operación",
  ],
  type: [
    "type",
    "tipo",
    "movimiento",
    "tipo de movimiento",
    "income/expense",
    "ingreso/egreso",
    "direction",
  ],
  amount: ["amount", "monto", "importe", "valor", "total", "value", "precio", "cantidad"],
  incomeAmount: [
    "income",
    "ingreso",
    "ingresos",
    "entrada",
    "credito",
    "crédito",
    "credit",
    "haber",
  ],
  expenseAmount: [
    "expense",
    "egreso",
    "egresos",
    "gasto",
    "gastos",
    "salida",
    "debito",
    "débito",
    "debit",
    "debe",
  ],
  currency: ["currency", "moneda", "divisa", "ccy", "cur"],
  description: [
    "description",
    "descripcion",
    "descripción",
    "detalle",
    "concepto",
    "concept",
    "memo",
    "item",
  ],
  counterparty: [
    "counterparty",
    "proveedor",
    "cliente",
    "comercio",
    "merchant",
    "payee",
    "vendor",
    "client",
    "beneficiario",
    "quien",
    "a quien",
    "de quien",
  ],
  category: ["category", "categoria", "categoría", "rubro"],
  subcategory: ["subcategory", "subcategoria", "subcategoría", "sub categoria", "sub-categoria"],
  account: [
    "account",
    "cuenta",
    "medio de pago",
    "medio",
    "forma de pago",
    "payment method",
    "tarjeta",
    "card",
    "wallet",
    "billetera",
  ],
  paymentMethod: ["metodo de pago", "método de pago", "payment", "pago con"],
  project: ["project", "proyecto", "entity", "entidad", "empresa", "unidad de negocio"],
  status: ["status", "estado", "state"],
  notes: ["notes", "notas", "nota", "observaciones", "comentarios", "comments", "comment"],
  reference: [
    "reference",
    "referencia",
    "id",
    "numero",
    "número",
    "nro",
    "comprobante",
    "factura",
    "invoice",
  ],
};

export const financeMappingSchema = z
  .object({
    columns: z.partialRecord(z.enum(FINANCE_FIELDS), z.number().int().min(0).max(200)),
    /** Decimal separator of amounts written as text; null = only unambiguous values parse. */
    numberFormat: z.enum(["dot_decimal", "comma_decimal"]).nullable().default(null),
    dateFormat: z.enum(["dmy", "mdy", "ymd"]).nullable().default(null),
    /** For rows without a currency column (or "$" alone). */
    defaultCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default(null),
    /** For rows without a type column or sign: every row is an expense (or income). */
    defaultType: z.enum(["income", "expense"]).nullable().default(null),
    /** Rows before this one are ignored; this row holds the headers. */
    headerRow: z.number().int().min(0).max(50).default(0),
    /** Import rows ELISE flags as probable duplicates anyway. */
    includeDuplicates: z.boolean().default(false),
  })
  .strict();
export type FinanceMapping = z.infer<typeof financeMappingSchema>;

/** Deterministic suggestion: exact header synonyms first, then partial ones, one field per column. */
export function suggestFinanceMapping(headers: string[]): FinanceMapping["columns"] {
  const columns: FinanceMapping["columns"] = {};
  const used = new Set<number>();
  const normalized = headers.map((h) => norm(h ?? ""));
  for (const pass of ["exact", "partial"] as const) {
    for (const field of FINANCE_FIELDS) {
      if (columns[field] !== undefined) continue;
      const synonyms = SYNONYMS[field].map(norm);
      const index = normalized.findIndex(
        (h, i) =>
          !used.has(i) &&
          h.length > 0 &&
          (pass === "exact"
            ? synonyms.includes(h)
            : synonyms.some((s) => s.length >= 4 && (h.includes(s) || s.includes(h)))),
      );
      if (index >= 0) {
        columns[field] = index;
        used.add(index);
      }
    }
  }
  // A single amount column already covers both directions.
  if (columns.amount !== undefined) {
    delete columns.incomeAmount;
    delete columns.expenseAmount;
  }
  return columns;
}

export type DateFormat = "dmy" | "mdy" | "ymd";

/** d/m vs m/d from the values: a first part above 12 means dmy, a second above 12 means mdy. */
export function detectDateFormat(values: readonly string[]): DateFormat | null {
  let dmy = false;
  let mdy = false;
  let ymd = false;
  for (const v of values) {
    const s = v.trim();
    if (isIsoDate(s.slice(0, 10)) || /^\d{5}(\.\d+)?$/.test(s)) continue;
    const m = s.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/);
    if (!m) continue;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m[1]!.length === 4) ymd = true;
    else if (a > 12) dmy = true;
    else if (b > 12) mdy = true;
  }
  if (ymd && !dmy && !mdy) return "ymd";
  if (dmy && !mdy) return "dmy";
  if (mdy && !dmy) return "mdy";
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * A date cell → ISO. Accepts ISO dates, spreadsheet serial numbers (days since 1899-12-30) and
 * d/m/y, m/d/y or y/m/d with "/", "-" or "."; two-digit years are 20xx. Ambiguous day/month
 * without a format is refused, never guessed.
 */
export function parseDate(value: string, format: DateFormat | null): string | null {
  const s = value.trim();
  if (!s) return null;
  if (isIsoDate(s.slice(0, 10))) return s.slice(0, 10);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Math.floor(Number(s));
    if (serial < 20000 || serial > 80000) return null;
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  const m = s.match(/^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/);
  if (!m) return null;
  const [p1, p2, p3] = [m[1]!, m[2]!, m[3]!];
  const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  if (p1.length === 4) return validDate(Number(p1), Number(p2), Number(p3));
  const a = Number(p1);
  const b = Number(p2);
  const fmt = format ?? (a > 12 ? "dmy" : b > 12 ? "mdy" : null);
  if (fmt === "dmy") return validDate(year(p3), b, a);
  if (fmt === "mdy") return validDate(year(p3), a, b);
  return null;
}

export interface NormalizedTransaction {
  type: TransactionType;
  amount: string;
  currency: string;
  date: string;
  description: string | null;
  counterparty: string | null;
  category: string | null;
  subcategory: string | null;
  account: string | null;
  paymentMethod: string | null;
  project: string | null;
  status: TransactionStatus;
  notes: string | null;
  reference: string | null;
  fingerprint: string;
}

export type RowIssue =
  | "missing_date"
  | "invalid_date"
  | "missing_amount"
  | "invalid_amount"
  | "zero_amount"
  | "missing_type"
  | "unknown_type"
  | "missing_currency"
  | "unknown_currency"
  | "unknown_status";

export type RowResult =
  | { row: number; ok: true; tx: NormalizedTransaction }
  | { row: number; ok: false; issues: RowIssue[]; empty?: boolean };

const clip = (v: string | undefined, max: number) => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, max) : null;
};

/** One spreadsheet row → a validated transaction, or the exact reasons it isn't one. */
export function normalizeRow(cells: Cell[], mapping: FinanceMapping, row: number): RowResult {
  const col = (f: FinanceField) => {
    const i = mapping.columns[f];
    return i === undefined ? undefined : (cells[i] ?? "").trim();
  };
  if (cells.every((c) => !c?.trim())) return { row, ok: false, issues: [], empty: true };
  const issues: RowIssue[] = [];

  const dateText = col("date");
  const date = dateText ? parseDate(dateText, mapping.dateFormat) : null;
  if (!dateText) issues.push("missing_date");
  else if (!date) issues.push("invalid_date");

  let amountText = col("amount");
  let typeFromColumn: TransactionType | null = null;
  if (!amountText) {
    const income = col("incomeAmount");
    const expense = col("expenseAmount");
    if (income && parseAmount(income, mapping.numberFormat)?.amount !== "0") {
      amountText = income;
      typeFromColumn = "income";
    } else if (expense) {
      amountText = expense;
      typeFromColumn = "expense";
    }
  }
  const parsed = amountText ? parseAmount(amountText, mapping.numberFormat) : null;
  if (!amountText) issues.push("missing_amount");
  else if (!parsed) issues.push("invalid_amount");
  else if (toUnits(parsed.amount) === 0n) issues.push("zero_amount");

  let type: TransactionType | null = typeFromColumn;
  const typeText = col("type");
  if (!type && typeText) {
    type = normalizeType(typeText);
    if (!type) issues.push("unknown_type");
  } else if (!type) {
    // No type given: a sign says it ("-25" is money going out), else the user's default.
    type = parsed?.negative ? "expense" : mapping.defaultType;
    if (!type) issues.push("missing_type");
  }

  const currencyText = col("currency");
  let currency: string | null = null;
  if (currencyText) {
    currency =
      normalizeCurrency(currencyText) ??
      (/^\$$/.test(currencyText) ? mapping.defaultCurrency : null);
    if (!currency) issues.push("unknown_currency");
  } else {
    currency = mapping.defaultCurrency;
    if (!currency) issues.push("missing_currency");
  }

  const statusText = col("status");
  const status = statusText ? normalizeStatus(statusText) : "completed";
  if (!status) issues.push("unknown_status");

  if (issues.length) return { row, ok: false, issues };
  const tx = {
    type: type!,
    amount: parsed!.amount,
    currency: currency!,
    date: date!,
    description: clip(col("description"), 300),
    counterparty: clip(col("counterparty"), 200),
    category: clip(col("category"), 80),
    subcategory: clip(col("subcategory"), 80),
    account: clip(col("account"), 80),
    paymentMethod: clip(col("paymentMethod"), 80),
    project: clip(col("project"), 120),
    status: status!,
    notes: clip(col("notes"), 2000),
    reference: clip(col("reference"), 200),
  };
  return { row, ok: true, tx: { ...tx, fingerprint: fingerprint(tx) } };
}

export interface FinancePreview {
  totalRows: number;
  valid: number;
  invalid: number;
  /** Valid rows that match a transaction ELISE Finance already has. */
  duplicates: number;
  /** Valid rows identical to another row of the same file (kept; shown for review). */
  repeatedInFile: number;
  willImport: number;
  byCurrency: {
    currency: string;
    income: string;
    expense: string;
    incomeCount: number;
    expenseCount: number;
  }[];
  sample: (NormalizedTransaction & { row: number })[];
  issues: { row: number; issues: RowIssue[]; cells: string[] }[];
  duplicateSample: (NormalizedTransaction & { row: number })[];
  /** What the user still has to decide before importing. */
  needs: ("numberFormat" | "dateFormat" | "defaultCurrency" | "defaultType" | "amount" | "date")[];
  dateRange: { from: string; to: string } | null;
}

/** Body rows of a sheet (after the header row), numbered like the spreadsheet (1-based). */
export function bodyRows(rows: Cell[][], headerRow: number): { cells: Cell[]; row: number }[] {
  return rows.slice(headerRow + 1).map((cells, i) => ({ cells, row: headerRow + i + 2 }));
}

export function normalizeAll(rows: Cell[][], mapping: FinanceMapping): RowResult[] {
  return bodyRows(rows, mapping.headerRow)
    .map(({ cells, row }) => normalizeRow(cells, mapping, row))
    .filter((r) => r.ok || !r.empty);
}

/**
 * Everything the user reviews before importing. `existing` holds fingerprints already in
 * ELISE Finance: matching rows are probable duplicates and are skipped unless the user
 * includes them.
 */
export function buildFinancePreview(
  rows: Cell[][],
  mapping: FinanceMapping,
  existing: ReadonlySet<string>,
): FinancePreview {
  const results = normalizeAll(rows, mapping);
  const valid = results.filter((r): r is Extract<RowResult, { ok: true }> => r.ok);
  const invalid = results.filter((r): r is Extract<RowResult, { ok: false }> => !r.ok);
  const duplicates = valid.filter((r) => existing.has(r.tx.fingerprint));
  const seen = new Map<string, number>();
  for (const r of valid) seen.set(r.tx.fingerprint, (seen.get(r.tx.fingerprint) ?? 0) + 1);
  const importing = mapping.includeDuplicates
    ? valid
    : valid.filter((r) => !existing.has(r.tx.fingerprint));

  const byCurrency = new Map<string, { i: bigint; e: bigint; ic: number; ec: number }>();
  for (const r of importing) {
    const c = byCurrency.get(r.tx.currency) ?? { i: 0n, e: 0n, ic: 0, ec: 0 };
    if (r.tx.type === "income") {
      c.i += toUnits(r.tx.amount);
      c.ic++;
    } else {
      c.e += toUnits(r.tx.amount);
      c.ec++;
    }
    byCurrency.set(r.tx.currency, c);
  }

  const needs: FinancePreview["needs"] = [];
  const amountCol = mapping.columns.amount ?? mapping.columns.expenseAmount;
  const dateCol = mapping.columns.date;
  if (amountCol === undefined) needs.push("amount");
  if (dateCol === undefined) needs.push("date");
  const body = bodyRows(rows, mapping.headerRow);
  if (
    !mapping.numberFormat &&
    invalid.some((r) => r.issues.includes("invalid_amount")) &&
    amountCol !== undefined &&
    detectNumberFormat(body.map((b) => b.cells[amountCol] ?? "")) === null
  )
    needs.push("numberFormat");
  if (!mapping.dateFormat && invalid.some((r) => r.issues.includes("invalid_date")))
    needs.push("dateFormat");
  if (
    invalid.some(
      (r) => r.issues.includes("missing_currency") || r.issues.includes("unknown_currency"),
    )
  )
    needs.push("defaultCurrency");
  if (invalid.some((r) => r.issues.includes("missing_type"))) needs.push("defaultType");

  const dates = valid.map((r) => r.tx.date).sort();
  return {
    totalRows: results.length,
    valid: valid.length,
    invalid: invalid.length,
    duplicates: duplicates.length,
    repeatedInFile: [...seen.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0),
    willImport: importing.length,
    byCurrency: [...byCurrency.entries()].map(([currency, c]) => ({
      currency,
      income: fromUnits(c.i),
      expense: fromUnits(c.e),
      incomeCount: c.ic,
      expenseCount: c.ec,
    })),
    sample: importing.slice(0, 8).map((r) => ({ ...r.tx, row: r.row })),
    issues: invalid.slice(0, 100).map((r) => ({
      row: r.row,
      issues: r.issues,
      cells: (body.find((b) => b.row === r.row)?.cells ?? [])
        .slice(0, 16)
        .map((c) => c.slice(0, 60)),
    })),
    duplicateSample: duplicates.slice(0, 5).map((r) => ({ ...r.tx, row: r.row })),
    needs: [...new Set(needs)],
    dateRange: dates.length ? { from: dates[0]!, to: dates.at(-1)! } : null,
  };
}

/**
 * Identity of each row of a connected sheet across syncs: its content fingerprint plus which
 * occurrence it is. Moving rows keeps their key; editing a row gives it a new one.
 */
export function rowKeys(txs: { fingerprint: string }[]): string[] {
  const seen = new Map<string, number>();
  return txs.map((t) => {
    const n = (seen.get(t.fingerprint) ?? 0) + 1;
    seen.set(t.fingerprint, n);
    return `${t.fingerprint}#${n}`;
  });
}

/** The format detected from a column's values, offered as the default in the mapping step. */
export function detectFormats(rows: Cell[][], columns: FinanceMapping["columns"], headerRow = 0) {
  const body = bodyRows(rows, headerRow).slice(0, 500);
  const pick = (f: FinanceField) =>
    columns[f] === undefined ? [] : body.map((b) => b.cells[columns[f]!] ?? "").filter(Boolean);
  const amounts = [...pick("amount"), ...pick("incomeAmount"), ...pick("expenseAmount")];
  return {
    numberFormat: detectNumberFormat(amounts) as NumberFormat | null,
    dateFormat: detectDateFormat(pick("date")),
  };
}

/**
 * The delimiter of a CSV from its first lines (outside quotes): ";" files are common where
 * "," is the decimal separator, so the delimiter is chosen once, never per character.
 */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  let lines = 0;
  for (const ch of text.slice(0, 20_000)) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "\n" && ++lines >= 10) break;
    else if (!quoted && (ch === "," || ch === ";" || ch === "\t")) counts[ch]++;
  }
  if (counts["\t"] > counts[";"] && counts["\t"] > counts[","]) return "\t";
  return counts[";"] > counts[","] ? ";" : ",";
}

/** RFC 4180 CSV with one delimiter: quoted fields, doubled quotes, CRLF, BOM. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): Cell[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Maximum rows imported synchronously; larger files run in the background. */
export const SYNC_IMPORT_ROWS = 500;
export const MAX_FINANCE_IMPORT_ROWS = 50_000;
