import {
  bodyRows,
  detectDateFormat,
  FINANCE_FIELDS,
  parseDate,
  suggestFinanceMapping,
  type Cell,
  type FinanceField,
  type FinanceMapping,
} from "./import";
import { normalizeCurrency, parseAmount, toUnits } from "./money";
import { norm, normalizeType } from "../capabilities/finance";

/**
 * Spreadsheet schema inference (ADR-073): files from other apps don't look like ELISE's. The
 * columns are profiled from their values — not only their headers — so ELISE picks the sheet,
 * the header row, the real amount and account columns and the useful description itself.
 * Deterministic: the model only fills what this leaves open (ai-mapping), and every row is
 * still validated by `normalizeRow`.
 */

export interface ColumnProfile {
  index: number;
  header: string;
  /** Share of body rows with a value. */
  filled: number;
  /** Of the filled cells: share that parse as an amount / a date / a transaction type. */
  numeric: number;
  date: number;
  type: number;
  /** Distinct filled values / filled values. */
  distinct: number;
  /** Of the filled cells: share with letters (human-readable text). */
  text: number;
}

const SAMPLE_ROWS = 400;

export function profileColumns(headers: string[], body: Cell[][]): ColumnProfile[] {
  const rows = body.slice(0, SAMPLE_ROWS);
  const width = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  return Array.from({ length: width }, (_, index) => {
    const values = rows.map((r) => (r[index] ?? "").trim()).filter(Boolean);
    const n = values.length || 1;
    const share = (test: (v: string) => boolean) => values.filter(test).length / n;
    return {
      index,
      header: (headers[index] ?? "").trim(),
      filled: rows.length ? values.length / rows.length : 0,
      numeric: share((v) => parseAmount(v, null) !== null),
      date: share((v) => parseDate(v, null) !== null || parseDate(v, "dmy") !== null),
      type: share((v) => normalizeType(v) !== null),
      distinct: new Set(values).size / n,
      text: share((v) => /\p{L}/u.test(v)),
    };
  });
}

/**
 * The header row: the top row that names the most finance fields (rules), else the first
 * mostly-text row. Titles, blank lines and export notes above it are skipped.
 */
export function detectHeaderRow(rows: Cell[][]): number {
  let best = { row: -1, hits: 1 };
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const hits = Object.keys(suggestFinanceMapping(rows[i] ?? [])).length;
    if (hits > best.hits) best = { row: i, hits };
  }
  if (best.row >= 0) return best.row;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const filled = rows[i]!.filter((c) => c.trim());
    const texty = filled.filter((c) => !/^[-\d.,$€\s/:]+$/.test(c));
    if (filled.length >= 2 && texty.length >= Math.ceil(filled.length * 0.6)) return i;
  }
  return 0;
}

const synonymsOf = (field: FinanceField, header: string) =>
  suggestFinanceMapping([header])[field] !== undefined;

/** Two amount columns with the same value on every row are one amount written twice. */
function sameAmounts(body: Cell[][], a: number, b: number): boolean {
  let compared = 0;
  for (const r of body.slice(0, SAMPLE_ROWS)) {
    const x = parseAmount(r[a] ?? "", null);
    const y = parseAmount(r[b] ?? "", null);
    if (!x && !y) continue;
    if (!x || !y || toUnits(x.amount) !== toUnits(y.amount)) return false;
    compared++;
  }
  return compared > 0;
}

/** How useful a column is as a transaction's description: filled, varied, human text. */
const describes = (p: ColumnProfile) => p.filled * p.text * Math.min(1, p.distinct * 3);

export interface InferredMapping {
  columns: FinanceMapping["columns"];
  /** Columns ELISE understood and deliberately left out (copies of another column, empty…). */
  ignored: { index: number; reason: "duplicate" | "empty" | "unused" }[];
  /** A currency the amount column's header names ("ARS"), when there's no currency column. */
  currency: string | null;
}

/**
 * Headers + values → which column is which. Header synonyms propose; the values decide:
 * an "Account" full of numbers isn't the account, a "Description" that is almost always empty
 * loses to a "Note" that describes every row, an amount written twice ("ARS" and "Amount") is
 * read once, and a header that is a currency code ("ARS") also says the currency.
 */
export function inferFinanceMapping(headers: string[], body: Cell[][]): InferredMapping {
  const profiles = profileColumns(headers, body);
  const used = new Set<number>();
  const columns: FinanceMapping["columns"] = {};
  const take = (field: FinanceField, p: ColumnProfile | undefined) => {
    if (!p) return;
    columns[field] = p.index;
    used.add(p.index);
  };
  const free = (test: (p: ColumnProfile) => boolean) =>
    profiles.filter((p) => !used.has(p.index) && p.filled > 0 && test(p));
  const best = (list: ColumnProfile[], score: (p: ColumnProfile) => number) =>
    [...list].sort((a, b) => score(b) - score(a) || a.index - b.index)[0];

  // Dates: a dated column, by name first, else the most date-like one.
  take(
    "date",
    best(
      free((p) => p.date >= 0.6 && synonymsOf("date", p.header)),
      (p) => p.date,
    ) ??
      best(
        free((p) => p.date >= 0.9),
        (p) => p.date,
      ),
  );

  // Amounts: named amount columns, or columns named after a currency, holding numbers.
  const currencyHeader = (p: ColumnProfile) =>
    /^[A-Za-z]{3}$/.test(p.header) && normalizeCurrency(p.header) !== null;
  // A named amount column stays the amount with a few broken cells (those rows are reported
  // one by one); an unnamed one must be clearly numeric.
  const amounts = free(
    (p) =>
      (synonymsOf("amount", p.header) && p.numeric >= 0.6) ||
      (currencyHeader(p) && p.numeric >= 0.9),
  );
  const amount = best(amounts, (p) => (synonymsOf("amount", p.header) ? 2 : 1) + p.filled);
  let currency: string | null = null;
  const ignored: InferredMapping["ignored"] = [];
  if (amount) {
    take("amount", amount);
    if (currencyHeader(amount)) currency = normalizeCurrency(amount.header);
    // The same value in another column (a currency-named copy, a running "Account" column…).
    for (const p of free((q) => q.numeric >= 0.9)) {
      if (!sameAmounts(body, amount.index, p.index)) continue;
      if (!currency && currencyHeader(p)) currency = normalizeCurrency(p.header);
      ignored.push({ index: p.index, reason: "duplicate" });
      used.add(p.index);
    }
  } else {
    const income = best(
      free((p) => p.numeric >= 0.5 && synonymsOf("incomeAmount", p.header)),
      (p) => p.filled,
    );
    const expense = best(
      free((p) => p.numeric >= 0.5 && synonymsOf("expenseAmount", p.header)),
      (p) => p.filled,
    );
    if (income && expense) {
      take("incomeAmount", income);
      take("expenseAmount", expense);
    }
  }

  take(
    "type",
    best(
      free((p) => p.type >= 0.8),
      (p) => p.type + (synonymsOf("type", p.header) ? 1 : 0),
    ),
  );
  take(
    "currency",
    best(
      free((p) => synonymsOf("currency", p.header) && p.text >= 0.5),
      (p) => p.filled,
    ),
  );
  // Accounts and categories are names (mostly text, a handful repeated), never numbers.
  const names = (p: ColumnProfile) => p.text >= 0.8 && p.numeric < 0.5;
  for (const field of ["account", "toAccount", "category", "subcategory", "book"] as const)
    take(
      field,
      best(
        free((p) => names(p) && synonymsOf(field, p.header)),
        (p) => p.filled,
      ),
    );

  // The description is the most informative text column; a second distinct one is the note.
  const texts = free(
    (p) =>
      p.text >= 0.5 &&
      (synonymsOf("description", p.header) ||
        synonymsOf("notes", p.header) ||
        synonymsOf("counterparty", p.header)),
  ).filter((p) => describes(p) > 0);
  const [first, second] = [...texts].sort((a, b) => describes(b) - describes(a));
  take("description", first);
  // A sparse detail column ("Description" on a few rows) is still worth keeping as the note.
  if (second && second.text >= 0.5) take("notes", second);

  // Everything else the rules know (reference, status, project…), as the header says.
  const rules = suggestFinanceMapping(headers);
  for (const field of FINANCE_FIELDS) {
    const i = rules[field];
    if (columns[field] !== undefined || i === undefined || used.has(i)) continue;
    if (["amount", "incomeAmount", "expenseAmount", "date", "account"].includes(field)) continue;
    if (profiles[i] && profiles[i]!.filled === 0) continue;
    take(field, profiles[i]);
  }

  for (const p of profiles)
    if (!used.has(p.index) && p.header)
      ignored.push({ index: p.index, reason: p.filled === 0 ? "empty" : "unused" });
  return { columns, ignored: ignored.sort((a, b) => a.index - b.index), currency };
}

/** Sheets that are rarely the data: dashboards, summaries, settings. */
const NOT_DATA =
  /^(dashboard|resumen|summary|charts?|graficos?|instrucciones|instructions|config|settings|categorias|categories|totales?)$/;

/** How much a sheet looks like a list of transactions (0 = not at all). */
export function transactionSheetScore(name: string, rows: Cell[][]): number {
  if (rows.length < 2) return 0;
  const header = detectHeaderRow(rows);
  const body = bodyRows(rows, header).map((b) => b.cells);
  const { columns } = inferFinanceMapping(rows[header] ?? [], body);
  const hasAmount =
    columns.amount !== undefined ||
    (columns.incomeAmount !== undefined && columns.expenseAmount !== undefined);
  if (columns.date === undefined || !hasAmount) return 0;
  const named = ["type", "account", "category", "description"].filter(
    (f) => columns[f as FinanceField] !== undefined,
  ).length;
  return (NOT_DATA.test(norm(name)) ? 0.25 : 1) * (2 + named + Math.min(body.length, 2000) / 2000);
}

/** The sheet to import: the one that clearly holds transactions (else the first with rows). */
export function pickTransactionSheet<T extends { name: string; rows: Cell[][] }>(
  sheets: readonly T[],
): T | undefined {
  const scored = sheets.map((s) => ({ s, score: transactionSheetScore(s.name, s.rows) }));
  const top = scored.sort((a, b) => b.score - a.score)[0];
  return top && top.score > 0 ? top.s : sheets.find((s) => s.rows.length > 1);
}

/** Formats seen in the chosen columns (day/month order), for the mapping defaults. */
export function inferDateFormat(body: Cell[][], dateColumn: number | undefined) {
  return dateColumn === undefined
    ? null
    : detectDateFormat(body.slice(0, SAMPLE_ROWS).map((r) => r[dateColumn] ?? ""));
}
