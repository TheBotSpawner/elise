import { z } from "zod";

import { isSingleEmoji } from "../emoji";
import type { EntrySource } from "./habits";
import {
  addAmounts,
  averageAmount,
  compareAmounts,
  divideByRate,
  fromUnits,
  isDecimal,
  multiplyByRate,
  normalizeAmount,
  normalizeCurrency,
  percentChange,
  shareTenths,
  subtractAmounts,
  toUnits,
} from "../finance/money";
import {
  comparisonPeriod,
  PERIODS,
  resolvePeriod,
  type Period,
  type PeriodPreset,
} from "../periods";
import type { ProviderKey } from "../providers/types";
import { normalizeEntityTitle } from "../text";
import { addDays, isIsoDate } from "../time";

/**
 * Finance (docs/architecture/10 §20-26): structured income and expenses, not banking.
 * Every number the user sees is computed here from records — never by the model — and totals
 * are always per currency: USD and ARS are never added together without an explicit rate
 * (none is configured today, so none is ever applied).
 */

/** A transfer moves money between two own accounts: never income, never expense (ADR-052). */
export type TransactionType = "income" | "expense" | "transfer";
/** The two types that make totals. */
export type FlowType = "income" | "expense";
export type TransactionStatus = "completed" | "pending" | "cancelled";
export type AccountType =
  "cash" | "bank" | "credit_card" | "debit_card" | "digital_wallet" | "business" | "other";
export type CategoryType = "income" | "expense" | "both";

export const NATIVE_SOURCE_NAME = "ELISE Finance";

export interface FinanceProvenance {
  providerKey: ProviderKey;
  connectionId: string;
  /** User-facing source: "ELISE Finance", "Personal Finance · Gastos". */
  source: string;
  /** finance_sources id for connected sheets; null for ELISE Finance. */
  sourceId: string | null;
  /** Row in the sheet (connected sources) or in the imported file. */
  row: number | null;
}

/** Who the money belongs to (ADR-052): Personal, Empresa… — never a category. */
export interface FinanceBook {
  id: string;
  name: string;
  type: "personal" | "business" | "other";
  icon: string | null;
  description: string | null;
  reportingCurrency: string | null;
  isDefault: boolean;
}

/** Shown for transactions no Book has been chosen for yet. */
export const UNCLASSIFIED = "__unclassified";

/** How a transaction got here (detail/audit, not row chrome). */
export type TransactionOrigin = "manual" | "chat" | "import" | "google_sheets" | "system";

export interface FinanceTransaction {
  id: string;
  type: TransactionType;
  /** Positive decimal string; `type` gives the direction. */
  amount: string;
  currency: string;
  date: string;
  description: string | null;
  counterparty: string | null;
  category: string | null;
  categoryId: string | null;
  /** Category and its parents, top-down ("Food", "Groceries"): filters match any level. */
  categoryPath: string[];
  subcategory: string | null;
  account: string | null;
  accountId: string | null;
  paymentMethod: string | null;
  project: string | null;
  status: TransactionStatus;
  notes: string | null;
  importId: string | null;
  /** ADR-052. Null: "Sin clasificar". */
  bookId?: string | null;
  book?: string | null;
  /** Transfers: the account the money went to (`account` is where it came from). */
  toAccountId?: string | null;
  toAccount?: string | null;
  /** "Comprobante": a link or an id (invoice number, bank reference). */
  receipt?: string | null;
  origin?: TransactionOrigin;
  /** Rows of connected sheets are edited in the sheet, never in ELISE. */
  readOnly: boolean;
  fingerprint: string;
  provenance: FinanceProvenance;
  updatedAt: string;
}

export interface FinanceAccount {
  id: string;
  name: string;
  type: AccountType;
  currency: string | null;
  /** New transactions on this account belong to this Book unless told otherwise. */
  defaultBookId?: string | null;
}

export interface FinanceCategory {
  id: string;
  name: string;
  type: CategoryType;
  parentId: string | null;
  parent: string | null;
  /** Books it is offered in; empty = every Book. */
  bookIds?: string[];
  /** ADR-054: one emoji (validated); null shows the suggestion from the name. */
  icon?: string | null;
}

export interface FinanceSourceInfo {
  /** "native" or the finance_sources id. */
  key: string;
  name: string;
  kind: "native" | "google_sheets";
  lastSyncedAt: string | null;
  /** Counted in totals by default (connected sheets can be excluded to avoid double counting). */
  included: boolean;
}

export interface TransactionFilter {
  from?: string;
  to?: string;
  type?: TransactionType;
  /** A Book's name or id, or UNCLASSIFIED. */
  book?: string;
  subcategory?: string;
  currencies?: string[];
  account?: string;
  category?: string;
  counterparty?: string;
  project?: string;
  paymentMethod?: string;
  /** Free text over description, counterparty, notes, category, project. */
  text?: string;
  /** Default: completed only. Pending and cancelled are reported as excluded. */
  statuses?: TransactionStatus[];
  /** Restrict to one source by name ("ELISE", a sheet's name). */
  source?: string;
  minAmount?: string;
}

export interface NewTransaction {
  type: TransactionType;
  amount: string;
  currency: string;
  date: string;
  description?: string | null;
  counterparty?: string | null;
  categoryId?: string | null;
  subcategory?: string | null;
  accountId?: string | null;
  paymentMethod?: string | null;
  project?: string | null;
  status?: TransactionStatus;
  notes?: string | null;
  importId?: string | null;
  importRow?: number | null;
  externalReference?: string | null;
  bookId?: string | null;
  toAccountId?: string | null;
  receipt?: string | null;
}

export type TransactionPatch = Partial<Omit<NewTransaction, "importId" | "importRow">>;

/** Rows a provider returns for a query; `truncated` when the period had more than it may load. */
export interface TransactionPage {
  rows: FinanceTransaction[];
  truncated: boolean;
}

export interface FinanceProvider {
  readonly readOnly: boolean;
  sources(): Promise<FinanceSourceInfo[]>;
  /** Rows in the date range (and type, if given), newest first. Other filters apply in Core. */
  transactions(filter: TransactionFilter, max: number): Promise<TransactionPage>;
  getTransaction(id: string): Promise<FinanceTransaction | null>;
  createTransaction(t: NewTransaction, source: EntrySource): Promise<FinanceTransaction>;
  updateTransaction(id: string, patch: TransactionPatch): Promise<FinanceTransaction>;
  archiveTransaction(id: string): Promise<FinanceTransaction>;
  listAccounts(): Promise<FinanceAccount[]>;
  createAccount(
    a: { name: string; type: AccountType; currency: string | null },
    source: EntrySource,
  ): Promise<FinanceAccount>;
  /** Rename, retype, set currency or archive (its transactions keep their history). */
  updateAccount(
    id: string,
    patch: { name?: string; type?: AccountType; currency?: string | null; archived?: boolean },
  ): Promise<FinanceAccount>;
  listCategories(): Promise<FinanceCategory[]>;
  createCategory(
    c: { name: string; type: CategoryType; parentId: string | null; icon?: string | null },
    source: EntrySource,
  ): Promise<FinanceCategory>;
  /** ADR-054: rename, change icon or parent, archive (transactions keep their category). */
  updateCategory?(
    id: string,
    patch: { name?: string; icon?: string | null; parentId?: string | null; archived?: boolean },
  ): Promise<FinanceCategory>;
  settings(): Promise<{ defaultCurrency: string | null; reportingCurrency: string | null }>;
  /** Currencies used most recently, most used first (to ask "ARS or USD?"). */
  recentCurrencies(): Promise<string[]>;
  /** Archives what one import created; returns how many. */
  undoImport(importId: string): Promise<{ archived: number; label: string }>;
  describeImport(importId: string): Promise<{ label: string; imported: number } | null>;
  /** ADR-052 — ELISE Finance only (connected sheets have none of these). */
  listBooks?(): Promise<FinanceBook[]>;
  saveBook?(
    b: Partial<Omit<FinanceBook, "id">> & { id?: string; archived?: boolean },
  ): Promise<FinanceBook>;
  updateAccountBook?(accountId: string, bookId: string | null): Promise<void>;
  listBudgets?(): Promise<Budget[]>;
  saveBudget?(
    b: Omit<Budget, "id" | "book" | "category"> & { id?: string; archived?: boolean },
  ): Promise<Budget>;
  listRates?(): Promise<FxRate[]>;
  saveRate?(r: FxRate & { note?: string | null }): Promise<FxRate>;
}

export interface Budget {
  id: string;
  bookId: string | null;
  book: string | null;
  categoryId: string;
  category: string;
  subcategory: string | null;
  currency: string;
  amount: string;
}

/** A dated, user-entered rate: 1 `from` = `rate` `to`, from `date` on. */
export interface FxRate {
  from: string;
  to: string;
  rate: string;
  date: string;
}

// ── Normalization shared by chat, UI and imports ─────────────────────────────

export const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Canonical identity of a transaction for duplicate detection: same day, direction, amount,
 * currency and counterparty (or description). Two coffees on one day look alike on purpose;
 * imports report them as probable duplicates instead of deciding.
 */
export function fingerprint(t: {
  date: string;
  type: TransactionType;
  amount: string;
  currency: string;
  counterparty?: string | null;
  description?: string | null;
}): string {
  const who = norm(t.counterparty || t.description || "").slice(0, 60);
  return `${t.date}|${t.type}|${normalizeAmount(t.amount)}|${t.currency}|${who}`;
}

const TYPE_WORDS: Record<string, TransactionType> = {
  transfer: "transfer",
  transferencia: "transfer",
  "transferencia interna": "transfer",
  "movimiento interno": "transfer",
  "internal transfer": "transfer",
  expense: "expense",
  expenses: "expense",
  gasto: "expense",
  gastos: "expense",
  egreso: "expense",
  egresos: "expense",
  salida: "expense",
  debito: "expense",
  debit: "expense",
  pago: "expense",
  compra: "expense",
  out: "expense",
  income: "income",
  ingreso: "income",
  ingresos: "income",
  entrada: "income",
  credito: "income",
  credit: "income",
  cobro: "income",
  venta: "income",
  revenue: "income",
  in: "income",
};

export function normalizeType(value: string | null | undefined): TransactionType | null {
  return value ? (TYPE_WORDS[norm(value)] ?? null) : null;
}

const STATUS_WORDS: Record<string, TransactionStatus> = {
  completed: "completed",
  complete: "completed",
  done: "completed",
  paid: "completed",
  cleared: "completed",
  pagado: "completed",
  "pagado/cobrado": "completed",
  "pagado / cobrado": "completed",
  "cobrado/pagado": "completed",
  pagada: "completed",
  cobrado: "completed",
  cobrada: "completed",
  confirmado: "completed",
  realizado: "completed",
  ok: "completed",
  pending: "pending",
  pendiente: "pending",
  "a pagar": "pending",
  "a cobrar": "pending",
  programado: "pending",
  cancelled: "cancelled",
  canceled: "cancelled",
  cancelado: "cancelled",
  cancelada: "cancelled",
  anulado: "cancelled",
  anulada: "cancelled",
};

export function normalizeStatus(value: string | null | undefined): TransactionStatus | null {
  if (!value || !value.trim()) return null;
  return STATUS_WORDS[norm(value)] ?? null;
}

// ── Periods ──────────────────────────────────────────────────────────────────

export { comparisonPeriod, PERIODS, resolvePeriod, type Period, type PeriodPreset };

// ── Filtering ────────────────────────────────────────────────────────────────

function contains(value: string | null | undefined, wanted: string) {
  return value ? norm(value).includes(norm(wanted)) : false;
}

/** Applies every filter uniformly, whatever the source (native or a connected sheet). */
export function matchesFilter(t: FinanceTransaction, f: TransactionFilter): boolean {
  const statuses = f.statuses?.length ? f.statuses : ["completed"];
  if (!statuses.includes(t.status)) return false;
  if (f.from && t.date < f.from) return false;
  if (f.to && t.date > f.to) return false;
  if (f.type && t.type !== f.type) return false;
  if (f.book) {
    if (f.book === UNCLASSIFIED) {
      if (t.bookId) return false;
    } else if (t.bookId !== f.book && !contains(t.book, f.book)) return false;
  }
  if (f.subcategory && !contains(t.subcategory, f.subcategory)) return false;
  if (f.currencies?.length && !f.currencies.includes(t.currency)) return false;
  if (f.account && !contains(t.account, f.account)) return false;
  if (
    f.category &&
    !t.categoryPath.some((c) => contains(c, f.category!)) &&
    !contains(t.subcategory, f.category)
  )
    return false;
  if (f.counterparty && !contains(t.counterparty, f.counterparty)) {
    if (!contains(t.description, f.counterparty)) return false;
  }
  if (f.project && !contains(t.project, f.project)) return false;
  if (f.paymentMethod && !contains(t.paymentMethod, f.paymentMethod)) {
    if (!contains(t.account, f.paymentMethod)) return false;
  }
  if (f.source && !contains(t.provenance.source, f.source)) return false;
  if (f.minAmount && compareAmounts(t.amount, f.minAmount) < 0) return false;
  if (f.text) {
    const hay = [
      t.description,
      t.counterparty,
      t.notes,
      t.category,
      t.subcategory,
      t.project,
      t.receipt,
      t.account,
      t.book,
    ]
      .filter(Boolean)
      .join(" ");
    if (!contains(hay, f.text)) return false;
  }
  return true;
}

/** What the default status filter left out, so answers can say "3 pending not included". */
export function excludedByStatus(rows: FinanceTransaction[], f: TransactionFilter) {
  const statuses = f.statuses?.length ? f.statuses : ["completed"];
  const others = rows.filter(
    (t) => !statuses.includes(t.status) && matchesFilter(t, { ...f, statuses: [t.status] }),
  );
  return {
    pending: others.filter((t) => t.status === "pending").length,
    cancelled: others.filter((t) => t.status === "cancelled").length,
  };
}

// ── Aggregation (mergeable across sources) ───────────────────────────────────

export interface CurrencyTotals {
  currency: string;
  income: string;
  expense: string;
  /** income − expense, in this currency only. */
  net: string;
  incomeCount: number;
  expenseCount: number;
}

export interface GroupTotal {
  key: string;
  type: FlowType;
  currency: string;
  total: string;
  count: number;
}

/** A compact transaction for results (no internal fields). */
export interface TransactionBrief {
  id: string;
  date: string;
  type: FlowType;
  amount: string;
  currency: string;
  label: string;
  category: string | null;
  source: string;
}

export interface Totals {
  totals: CurrencyTotals[];
  byCategory: GroupTotal[];
  largest: TransactionBrief[];
  count: number;
  excluded: { pending: number; cancelled: number };
  /** Transfers in the range: shown, never counted as income or expense. */
  transfers?: number;
}

export interface FinanceSummary {
  /** Explicit reporting-currency view (ADR-052); the per-currency totals stay authoritative. */
  converted?: ConvertedTotals | null;
  period: Period;
  comparison: Period | null;
  current: Totals;
  previous: Totals | null;
  sources: FinanceSourceInfo[];
  truncated: boolean;
  /** Derived after merging: never stored separately from the numbers above. */
  changes: {
    currency: string;
    income: number | null;
    expense: number | null;
    net: string;
    previousNet: string;
  }[];
  insights: FinanceInsight[];
}

export type FinanceInsight =
  | {
      kind: "category_up" | "category_down";
      category: string;
      currency: string;
      current: string;
      previous: string;
      percent: number;
    }
  | {
      kind: "large_transaction";
      transaction: TransactionBrief;
      average: string;
      times: number;
    };

const LARGEST = 8;

export function brief(t: FinanceTransaction): TransactionBrief {
  return {
    id: t.id,
    date: t.date,
    type: t.type === "income" ? "income" : "expense",
    amount: t.amount,
    currency: t.currency,
    label: t.counterparty || t.description || t.category || "—",
    category: t.category,
    source: t.provenance.source,
  };
}

const byAmountDesc = (a: TransactionBrief, b: TransactionBrief) =>
  compareAmounts(b.amount, a.amount) || b.date.localeCompare(a.date);

export function computeTotals(rows: FinanceTransaction[], f: TransactionFilter): Totals {
  const all = rows.filter((t) => matchesFilter(t, f));
  // Transfers move money between own accounts: they never make income or expense.
  const matched = all.filter((t) => t.type !== "transfer");
  const totals = new Map<string, { income: bigint; expense: bigint; ic: number; ec: number }>();
  const cats = new Map<string, { units: bigint; count: number; g: Omit<GroupTotal, "total"> }>();
  for (const t of matched) {
    const cur = totals.get(t.currency) ?? { income: 0n, expense: 0n, ic: 0, ec: 0 };
    if (t.type === "income") {
      cur.income += toUnits(t.amount);
      cur.ic++;
    } else {
      cur.expense += toUnits(t.amount);
      cur.ec++;
    }
    totals.set(t.currency, cur);
    const category = t.categoryPath[0] ?? t.category ?? "—";
    const key = `${t.type}|${t.currency}|${category}`;
    const c = cats.get(key) ?? {
      units: 0n,
      count: 0,
      g: { key: category, type: t.type as FlowType, currency: t.currency, count: 0 },
    };
    c.units += toUnits(t.amount);
    c.count++;
    cats.set(key, c);
  }
  return {
    totals: [...totals.entries()]
      .map(([currency, v]) => ({
        currency,
        income: fromUnits(v.income),
        expense: fromUnits(v.expense),
        net: fromUnits(v.income - v.expense),
        incomeCount: v.ic,
        expenseCount: v.ec,
      }))
      .sort((a, b) => b.incomeCount + b.expenseCount - (a.incomeCount + a.expenseCount)),
    byCategory: [...cats.values()]
      .map((c) => ({ ...c.g, total: fromUnits(c.units), count: c.count }))
      .sort((a, b) => a.currency.localeCompare(b.currency) || compareAmounts(b.total, a.total)),
    largest: matched
      .map(brief)
      .sort(byAmountDesc)
      .slice(0, LARGEST * 2),
    count: matched.length,
    excluded: excludedByStatus(rows, f),
    transfers: all.length - matched.length,
  };
}

/** Sums two sources' totals: per currency and per category, never across currencies. */
export function mergeTotals(a: Totals, b: Totals): Totals {
  const totals = new Map<string, CurrencyTotals>();
  for (const t of [...a.totals, ...b.totals]) {
    const cur = totals.get(t.currency);
    totals.set(
      t.currency,
      cur
        ? {
            currency: t.currency,
            income: addAmounts(cur.income, t.income),
            expense: addAmounts(cur.expense, t.expense),
            net: addAmounts(cur.net, t.net),
            incomeCount: cur.incomeCount + t.incomeCount,
            expenseCount: cur.expenseCount + t.expenseCount,
          }
        : t,
    );
  }
  return {
    totals: [...totals.values()].sort(
      (x, y) => y.incomeCount + y.expenseCount - (x.incomeCount + x.expenseCount),
    ),
    byCategory: mergeGroups(a.byCategory, b.byCategory),
    largest: [...a.largest, ...b.largest].sort(byAmountDesc).slice(0, LARGEST * 2),
    count: a.count + b.count,
    excluded: {
      pending: a.excluded.pending + b.excluded.pending,
      cancelled: a.excluded.cancelled + b.excluded.cancelled,
    },
    transfers: (a.transfers ?? 0) + (b.transfers ?? 0),
  };
}

export function mergeGroups(a: GroupTotal[], b: GroupTotal[]): GroupTotal[] {
  const groups = new Map<string, GroupTotal>();
  for (const g of [...a, ...b]) {
    const k = `${g.type}|${g.currency}|${norm(g.key)}`;
    const cur = groups.get(k);
    groups.set(
      k,
      cur ? { ...cur, total: addAmounts(cur.total, g.total), count: cur.count + g.count } : g,
    );
  }
  return [...groups.values()].sort(
    (x, y) => x.currency.localeCompare(y.currency) || compareAmounts(y.total, x.total),
  );
}

const INSIGHT_MIN_CHANGE = 30; // percent
const LARGE_FACTOR = 3;

/**
 * Explainable observations from computed numbers only: a category that moved at least 30% vs
 * the comparison period (and matters: ≥10% of that currency's spending), and an expense at
 * least 3× the average of its category in the comparison period (with 3+ earlier records).
 */
export function deriveInsights(current: Totals, previous: Totals | null): FinanceInsight[] {
  if (!previous) return [];
  const insights: FinanceInsight[] = [];
  for (const g of current.byCategory.filter((c) => c.type === "expense" && c.key !== "—")) {
    const before = previous.byCategory.find(
      (p) => p.type === "expense" && p.currency === g.currency && norm(p.key) === norm(g.key),
    );
    const spent = current.totals.find((t) => t.currency === g.currency)?.expense ?? "0";
    if (!before || toUnits(g.total) * 10n < toUnits(spent)) continue;
    const percent = percentChange(before.total, g.total);
    if (percent === null || Math.abs(percent) < INSIGHT_MIN_CHANGE) continue;
    insights.push({
      kind: percent > 0 ? "category_up" : "category_down",
      category: g.key,
      currency: g.currency,
      current: g.total,
      previous: before.total,
      percent,
    });
  }
  for (const t of current.largest.filter((x) => x.type === "expense" && x.category)) {
    const before = previous.byCategory.find(
      (p) => p.type === "expense" && p.currency === t.currency && norm(p.key) === norm(t.category!),
    );
    if (!before || before.count < 3) continue;
    const average = fromUnits(toUnits(before.total) / BigInt(before.count));
    if (toUnits(t.amount) < toUnits(average) * BigInt(LARGE_FACTOR)) continue;
    insights.push({
      kind: "large_transaction",
      transaction: t,
      average,
      times: Number((toUnits(t.amount) * 10n) / toUnits(average)) / 10,
    });
    if (insights.filter((i) => i.kind === "large_transaction").length >= 2) break;
  }
  return insights.slice(0, 5);
}

export function finalizeSummary(
  parts: Pick<FinanceSummary, "period" | "comparison" | "current" | "previous" | "sources"> & {
    truncated: boolean;
  },
): FinanceSummary {
  const changes = parts.previous
    ? parts.current.totals.map((t) => {
        const before = parts.previous!.totals.find((p) => p.currency === t.currency);
        return {
          currency: t.currency,
          income: before ? percentChange(before.income, t.income) : null,
          expense: before ? percentChange(before.expense, t.expense) : null,
          net: t.net,
          previousNet: before?.net ?? "0",
        };
      })
    : [];
  return {
    ...parts,
    current: { ...parts.current, largest: parts.current.largest.slice(0, LARGEST) },
    changes,
    insights: deriveInsights(parts.current, parts.previous),
  };
}

export function mergeSummaries(summaries: FinanceSummary[]): FinanceSummary {
  const [first, ...rest] = summaries;
  if (!first) throw new Error("Nothing to merge");
  let current = first.current;
  let previous = first.previous;
  const sources = [...first.sources];
  let truncated = first.truncated;
  for (const s of rest) {
    current = mergeTotals(current, s.current);
    previous =
      previous && s.previous ? mergeTotals(previous, s.previous) : (previous ?? s.previous);
    sources.push(...s.sources);
    truncated ||= s.truncated;
  }
  return finalizeSummary({
    period: first.period,
    comparison: first.comparison,
    current,
    previous,
    sources,
    truncated,
  });
}

// ── Breakdowns (finance.query) ───────────────────────────────────────────────

export const GROUP_BY = [
  "category",
  "subcategory",
  "book",
  "month",
  "week",
  "day",
  "account",
  "counterparty",
  "project",
  "payment_method",
  "source",
  "type",
  "currency",
] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export interface FinanceBreakdown {
  period: Period;
  groupBy: GroupBy | null;
  totals: CurrencyTotals[];
  groups: GroupTotal[];
  count: number;
  excluded: { pending: number; cancelled: number };
  sources: FinanceSourceInfo[];
  truncated: boolean;
}

function groupKey(t: FinanceTransaction, by: GroupBy): string {
  switch (by) {
    case "category":
      return t.categoryPath.at(-1) ?? t.category ?? "—";
    case "subcategory":
      return t.subcategory ?? "—";
    case "book":
      return t.book ?? "Sin clasificar";
    case "month":
      return t.date.slice(0, 7);
    case "week": {
      const weekday = (new Date(`${t.date}T00:00:00Z`).getUTCDay() + 6) % 7;
      return addDays(t.date, -weekday);
    }
    case "day":
      return t.date;
    case "account":
      return t.account ?? t.paymentMethod ?? "—";
    case "counterparty":
      return t.counterparty ?? t.description ?? "—";
    case "project":
      return t.project ?? "—";
    case "payment_method":
      return t.paymentMethod ?? t.account ?? "—";
    case "source":
      return t.provenance.source;
    case "type":
      return t.type;
    case "currency":
      return t.currency;
  }
}

export function computeBreakdown(
  rows: FinanceTransaction[],
  f: TransactionFilter & Period,
  by: GroupBy | null,
  sources: FinanceSourceInfo[],
  truncated: boolean,
): FinanceBreakdown {
  const totals = computeTotals(rows, f);
  const groups = new Map<string, { units: bigint; g: Omit<GroupTotal, "total"> }>();
  if (by) {
    for (const t of rows.filter((x) => matchesFilter(x, f) && x.type !== "transfer")) {
      const key = groupKey(t, by);
      const k = `${t.type}|${t.currency}|${norm(key)}`;
      const cur = groups.get(k) ?? {
        units: 0n,
        g: { key, type: t.type as FlowType, currency: t.currency, count: 0 },
      };
      cur.units += toUnits(t.amount);
      cur.g.count++;
      groups.set(k, cur);
    }
  }
  return {
    period: { from: f.from, to: f.to },
    groupBy: by,
    totals: totals.totals,
    groups: sortGroups(
      [...groups.values()].map((g) => ({ ...g.g, total: fromUnits(g.units) })),
      by,
    ),
    count: totals.count,
    excluded: totals.excluded,
    sources,
    truncated,
  };
}

function sortGroups(groups: GroupTotal[], by: GroupBy | null): GroupTotal[] {
  const chronological = by === "month" || by === "week" || by === "day";
  return groups.sort((a, b) =>
    chronological
      ? a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency)
      : a.currency.localeCompare(b.currency) || compareAmounts(b.total, a.total),
  );
}

export function mergeBreakdowns(parts: FinanceBreakdown[]): FinanceBreakdown {
  const [first, ...rest] = parts;
  if (!first) throw new Error("Nothing to merge");
  let totals: Totals = {
    totals: first.totals,
    byCategory: [],
    largest: [],
    count: first.count,
    excluded: first.excluded,
  };
  let groups = first.groups;
  const sources = [...first.sources];
  let truncated = first.truncated;
  for (const p of rest) {
    totals = mergeTotals(totals, {
      totals: p.totals,
      byCategory: [],
      largest: [],
      count: p.count,
      excluded: p.excluded,
    });
    groups = mergeGroups(groups, p.groups);
    sources.push(...p.sources);
    truncated ||= p.truncated;
  }
  return {
    ...first,
    totals: totals.totals,
    groups: sortGroups(groups, first.groupBy),
    count: totals.count,
    excluded: totals.excluded,
    sources,
    truncated,
  };
}

/** Transactions from several sources, newest first, with probable cross-source duplicates. */
export function mergeTransactionLists(lists: FinanceTransaction[][], limit: number) {
  const all = lists
    .flat()
    .sort((a, b) => b.date.localeCompare(a.date) || compareAmounts(b.amount, a.amount));
  const bySource = new Map<string, Set<string>>();
  for (const t of all) {
    const set = bySource.get(t.fingerprint) ?? new Set<string>();
    set.add(t.provenance.source);
    bySource.set(t.fingerprint, set);
  }
  const duplicated = new Set([...bySource.entries()].filter(([, s]) => s.size > 1).map(([f]) => f));
  return {
    rows: all.slice(0, limit),
    total: all.length,
    possibleDuplicates: all.filter((t) => duplicated.has(t.fingerprint)).length,
  };
}

export { averageAmount, subtractAmounts };

// ── ADR-052: reporting currency, budgets, trends ─────────────────────────────

export interface RateUsed extends FxRate {
  /** True when the stored pair was the reverse (USD→ARS used to convert ARS→USD). */
  inverse: boolean;
}

/**
 * The rate for one transaction: the latest user-entered rate on or before ITS date (never
 * today's rate for an old record), direct pair first, then the reverse pair. Null: no rate.
 */
export function rateFor(
  rates: readonly FxRate[],
  from: string,
  to: string,
  date: string,
): RateUsed | null {
  const pick = (a: string, b: string) =>
    rates
      .filter((r) => r.from === a && r.to === b && r.date <= date)
      .sort((x, y) => y.date.localeCompare(x.date))[0] ?? null;
  const direct = pick(from, to);
  if (direct) return { ...direct, inverse: false };
  const reverse = pick(to, from);
  return reverse ? { ...reverse, inverse: true } : null;
}

export interface ConvertedTotals {
  currency: string;
  income: string;
  expense: string;
  net: string;
  /** Every distinct rate applied, so the conversion is visible (detail and reports). */
  ratesUsed: RateUsed[];
  /** Transactions left out because no rate existed on/before their date, per currency. */
  unconverted: { currency: string; count: number }[];
}

/** One amount in the target currency, or null without a rate (never guessed). */
export function convertAmount(
  amount: string,
  currency: string,
  date: string,
  target: string,
  rates: readonly FxRate[],
): { amount: string; rate: RateUsed | null } | null {
  if (currency === target) return { amount, rate: null };
  const rate = rateFor(rates, currency, target, date);
  if (!rate) return null;
  return {
    amount: rate.inverse ? divideByRate(amount, rate.rate) : multiplyByRate(amount, rate.rate),
    rate,
  };
}

/**
 * Totals in a reporting currency, converted transaction by transaction at each one's own dated
 * rate. Original amounts and currencies are untouched; rows with no rate are reported, not summed.
 */
export function convertTotals(
  rows: FinanceTransaction[],
  f: TransactionFilter,
  target: string,
  rates: readonly FxRate[],
): ConvertedTotals {
  let income = 0n;
  let expense = 0n;
  const used = new Map<string, RateUsed>();
  const missing = new Map<string, number>();
  for (const t of rows.filter((x) => matchesFilter(x, f) && x.type !== "transfer")) {
    const c = convertAmount(t.amount, t.currency, t.date, target, rates);
    if (!c) {
      missing.set(t.currency, (missing.get(t.currency) ?? 0) + 1);
      continue;
    }
    if (c.rate) used.set(`${c.rate.from}|${c.rate.to}|${c.rate.date}`, c.rate);
    if (t.type === "income") income += toUnits(c.amount);
    else expense += toUnits(c.amount);
  }
  return {
    currency: target,
    income: fromUnits(income),
    expense: fromUnits(expense),
    net: fromUnits(income - expense),
    ratesUsed: [...used.values()].sort((a, b) => a.date.localeCompare(b.date)),
    unconverted: [...missing.entries()].map(([currency, count]) => ({ currency, count })),
  };
}

export type BudgetState = "ok" | "warning" | "over";

export interface BudgetUsage extends Budget {
  spent: string;
  remaining: string;
  /** Spent / budget, in tenths of a percent (823 = 82.3%), integer math. */
  percentTenths: number;
  state: BudgetState;
  /** Matching expenses in another currency: not added (no silent conversion). */
  otherCurrencies: number;
  /** Matching pending expenses (not counted as spent). */
  pending: number;
}

export const BUDGET_WARNING_TENTHS = 800;

/** Does this transaction count against the budget (Book + category or its children + sub)? */
export function inBudget(t: FinanceTransaction, b: Budget): boolean {
  if (t.type !== "expense") return false;
  if (b.bookId && t.bookId !== b.bookId) return false;
  const inCategory =
    t.categoryId === b.categoryId ||
    t.categoryPath.slice(0, -1).some((n) => norm(n) === norm(b.category));
  if (!inCategory) return false;
  return !b.subcategory || norm(t.subcategory ?? "") === norm(b.subcategory);
}

/** A monthly budget's use over the month's rows (completed spending only). */
export function budgetUsage(b: Budget, monthRows: FinanceTransaction[]): BudgetUsage {
  let spent = 0n;
  let other = 0;
  let pending = 0;
  for (const t of monthRows) {
    if (!inBudget(t, b)) continue;
    if (t.status === "cancelled") continue;
    if (t.status === "pending") {
      pending++;
      continue;
    }
    if (t.currency !== b.currency) {
      other++;
      continue;
    }
    spent += toUnits(t.amount);
  }
  const total = fromUnits(spent);
  const limit = toUnits(b.amount);
  return {
    ...b,
    spent: total,
    remaining: subtractAmounts(b.amount, total),
    percentTenths: shareTenths(total, b.amount),
    // Exact thresholds (79.99% is still fine): the display percent is rounded, the state isn't.
    state:
      spent >= limit
        ? "over"
        : spent * 1000n >= limit * BigInt(BUDGET_WARNING_TENTHS)
          ? "warning"
          : "ok",
    otherCurrencies: other,
    pending,
  };
}

export type Granularity = "day" | "week" | "month";

/** Deterministic: up to a month by day, up to ~4 months by week, otherwise by month. */
export function trendGranularity(from: string, to: string): Granularity {
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  return days <= 31 ? "day" : days <= 120 ? "week" : "month";
}

const bucketOf = (date: string, g: Granularity) =>
  g === "day"
    ? date
    : g === "month"
      ? date.slice(0, 7)
      : addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

/** Every bucket in the range, in order (empty buckets included: a gap is information). */
export function buckets(from: string, to: string, g: Granularity): string[] {
  const out: string[] = [];
  let cursor = bucketOf(from, g);
  for (let i = 0; i < 400 && cursor <= to; i++) {
    if (!out.includes(cursor)) out.push(cursor);
    cursor =
      g === "day" ? addDays(cursor, 1) : g === "week" ? addDays(cursor, 7) : nextMonth(cursor);
  }
  return out;
}

const nextMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

export interface TrendSeries {
  currency: string;
  granularity: Granularity;
  keys: string[];
  income: string[];
  expense: string[];
  net: string[];
}

/** Income / expense / net per bucket, one series set per currency (never mixed). */
export function trendSeries(
  rows: FinanceTransaction[],
  f: TransactionFilter & { from: string; to: string },
  g: Granularity = trendGranularity(f.from, f.to),
): TrendSeries[] {
  const keys = buckets(f.from, f.to, g);
  const by = new Map<string, Map<string, { i: bigint; e: bigint }>>();
  for (const t of rows.filter((x) => matchesFilter(x, f) && x.type !== "transfer")) {
    const cur = by.get(t.currency) ?? new Map();
    const k = bucketOf(t.date, g);
    const v = cur.get(k) ?? { i: 0n, e: 0n };
    if (t.type === "income") v.i += toUnits(t.amount);
    else v.e += toUnits(t.amount);
    cur.set(k, v);
    by.set(t.currency, cur);
  }
  return [...by.entries()].map(([currency, m]) => ({
    currency,
    granularity: g,
    keys,
    income: keys.map((k) => fromUnits(m.get(k)?.i ?? 0n)),
    expense: keys.map((k) => fromUnits(m.get(k)?.e ?? 0n)),
    net: keys.map((k) => fromUnits((m.get(k)?.i ?? 0n) - (m.get(k)?.e ?? 0n))),
  }));
}

/** The same series from `finance.query` groups by day/week/month (keys match `buckets`). */
export function trendFromGroups(
  groups: GroupTotal[],
  p: { from: string; to: string },
  g: Granularity,
): TrendSeries[] {
  const keys = buckets(p.from, p.to, g);
  const pick = (c: string, type: FlowType, k: string) =>
    groups.find((x) => x.currency === c && x.type === type && x.key === k)?.total ?? "0";
  return [...new Set(groups.map((x) => x.currency))].map((currency) => {
    const income = keys.map((k) => pick(currency, "income", k));
    const expense = keys.map((k) => pick(currency, "expense", k));
    return {
      currency,
      granularity: g,
      keys,
      income,
      expense,
      net: keys.map((_, i) => fromUnits(toUnits(income[i]!) - toUnits(expense[i]!))),
    };
  });
}

/** The first `n` groups and the rest summed as "Otros" (one currency, one type). */
export function topWithOther(groups: GroupTotal[], n: number, otherLabel: string): GroupTotal[] {
  const sorted = [...groups].sort((a, b) => compareAmounts(b.total, a.total));
  if (sorted.length <= n) return sorted;
  const rest = sorted.slice(n - 1);
  return [
    ...sorted.slice(0, n - 1),
    {
      key: otherLabel,
      type: rest[0]!.type,
      currency: rest[0]!.currency,
      total: addAmounts(...rest.map((g) => g.total)),
      count: rest.reduce((c, g) => c + g.count, 0),
    },
  ];
}

/** "Gastos - Herramientas" → "Herramientas": spreadsheet prefixes repeat the type, not the name. */
export function cleanCategoryName(name: string): string {
  return (
    name.replace(/^\s*(gastos?|ingresos?|egresos?|expenses?|income)\s*[-–:/]\s*/i, "").trim() ||
    name.trim()
  );
}

// ── Model-facing inputs ──────────────────────────────────────────────────────

const isoDate = z.string().refine(isIsoDate, "Use YYYY-MM-DD");
const text = (max: number) => z.string().trim().min(1).max(max);

/** Amounts come as "25.5" or 25.5 from the model; always stored as exact decimals. */
export const amountField = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? String(v) : v.trim()))
  .refine((v) => isDecimal(v) && toUnits(v) > 0n, {
    message: 'A positive amount with "." as decimal separator, e.g. "48000" or "25.5"',
  })
  .transform(normalizeAmount);

export const currencyField = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .transform((v, ctx) => {
    const code = normalizeCurrency(v);
    if (!code) {
      ctx.addIssue({
        code: "custom",
        message: `Unknown currency "${v}": ask the user (ISO code).`,
      });
      return z.NEVER;
    }
    return code;
  })
  .describe(
    "ISO code (USD, ARS, EUR, NZD…). Omit when the user did not say it; ELISE resolves it or asks.",
  );

export const filterFields = {
  period: z.enum(PERIODS).optional().describe("Calendar period in the user's local dates."),
  from: isoDate.optional().describe("Start date (inclusive), instead of period."),
  to: isoDate.optional().describe("End date (inclusive), instead of period."),
  type: z.enum(["income", "expense", "transfer"]).optional(),
  book: text(60)
    .optional()
    .describe(
      'Ámbito: who the money belongs to ("Personal", "Empresa"). "¿Cuánto gastamos en la empresa?" → book Empresa. Not a category.',
    ),
  currency: z.array(currencyField).max(10).optional(),
  category: text(80).optional().describe("Category name; includes its sub-categories."),
  subcategory: text(80).optional().describe('E.g. "ChatGPT", "Meta Ads".'),
  account: text(80).optional(),
  counterparty: text(200).optional().describe("Merchant, provider or client, e.g. OpenAI, Acme."),
  project: text(120).optional(),
  paymentMethod: text(80).optional(),
  text: text(200).optional(),
  status: z
    .array(z.enum(["completed", "pending", "cancelled"]))
    .max(3)
    .optional()
    .describe("Default: completed only."),
  source: text(200)
    .optional()
    .describe('Only one source, by name: "ELISE" or a connected Google Sheet\'s name.'),
};

export const listTransactionsInput = z
  .object({ ...filterFields, limit: z.number().int().min(1).max(100).default(20) })
  .strict();

export const summaryInput = z
  .object({
    ...filterFields,
    compare: z
      .enum(["previous", "last_year", "none"])
      .default("previous")
      .describe(
        '"previous": the period before (last month, Q2 for Q3). "last_year": same dates a year earlier.',
      ),
    reportingCurrency: currencyField
      .optional()
      .describe(
        'Only when the user asks to see it in one currency ("en pesos"): converted with the dated rates they entered; originals stay per currency.',
      ),
  })
  .strict();

export const queryInput = z
  .object({
    ...filterFields,
    groupBy: z.enum(GROUP_BY).optional().describe("How to break totals down."),
  })
  .strict();

export const transactionRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("The transaction id exactly as returned by a Finance tool.");

export const createTransactionInput = z
  .object({
    type: z
      .enum(["income", "expense", "transfer"])
      .describe("transfer: between two own accounts (never income or expense)."),
    book: text(60)
      .optional()
      .describe(
        'Ámbito ("Personal", "Empresa"). Omit when unclear: the account default Book or the default Book applies.',
      ),
    toAccount: text(80).optional().describe("Transfers: the account the money went to."),
    receipt: text(500).optional().describe("Comprobante: a link or an id (invoice number)."),
    amount: amountField,
    currency: currencyField.optional(),
    date: isoDate.optional().describe("Local date; default today."),
    description: text(300).optional(),
    counterparty: text(200).optional().describe("Who was paid or who paid: OpenAI, Acme, Coto."),
    category: text(80)
      .optional()
      .describe("An existing category name (see finance.listCategories)."),
    categoryInferred: z
      .boolean()
      .optional()
      .describe("true when YOU chose the category (the user did not say it)."),
    subcategory: text(80).optional(),
    account: text(80)
      .optional()
      .describe('Account or card named by the user ("Visa", "Cash USD").'),
    paymentMethod: text(80).optional(),
    project: text(120)
      .optional()
      .describe('Project or client it belongs to ("ELISE", "Client A").'),
    status: z.enum(["completed", "pending"]).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export const updateTransactionInput = z
  .object({
    transaction: transactionRef,
    type: z.enum(["income", "expense", "transfer"]).optional(),
    book: z.string().trim().max(60).nullable().optional().describe("null: Sin clasificar."),
    toAccount: z.string().trim().max(80).nullable().optional(),
    receipt: z.string().trim().max(500).nullable().optional(),
    amount: amountField.optional(),
    currency: currencyField.optional(),
    date: isoDate.optional(),
    description: z.string().trim().max(300).nullable().optional(),
    counterparty: z.string().trim().max(200).nullable().optional(),
    category: z.string().trim().max(80).nullable().optional(),
    subcategory: z.string().trim().max(80).nullable().optional(),
    account: z.string().trim().max(80).nullable().optional(),
    paymentMethod: z.string().trim().max(80).nullable().optional(),
    project: z.string().trim().max(120).nullable().optional(),
    status: z.enum(["completed", "pending", "cancelled"]).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

export const createAccountInput = z
  .object({
    name: text(80).overwrite(normalizeEntityTitle),
    type: z
      .enum(["cash", "bank", "credit_card", "debit_card", "digital_wallet", "business", "other"])
      .default("other"),
    currency: currencyField.optional(),
  })
  .strict();

export const updateAccountInput = z
  .object({
    account: text(80).describe("The account's current name."),
    name: text(80).overwrite(normalizeEntityTitle).optional(),
    type: z
      .enum(["cash", "bank", "credit_card", "debit_card", "digital_wallet", "business", "other"])
      .optional(),
    currency: currencyField.nullable().optional(),
    book: z
      .string()
      .trim()
      .max(60)
      .nullable()
      .optional()
      .describe(
        'Default Ámbito for its records ("la tarjeta de la empresa es de Empresa"); null clears it.',
      ),
    archived: z.boolean().optional().describe("true hides it from new records; history stays."),
  })
  .strict();

const emojiField = z.string().trim().refine(isSingleEmoji, "Expected one emoji");

export const updateCategoryInput = z
  .object({
    category: text(80).describe("The category's current name."),
    name: text(80).overwrite(normalizeEntityTitle).optional(),
    icon: emojiField.nullable().optional().describe("One emoji; null removes it."),
    parent: z.string().trim().max(80).nullable().optional(),
    archived: z
      .boolean()
      .optional()
      .describe("true hides it from new records; existing transactions keep it."),
  })
  .strict();

/** Icon suggested from a category's name (shown until the user picks one). */
const CATEGORY_ICONS: [RegExp, string][] = [
  [/super|almac|grocer|mercado/i, "🛒"],
  [/comida|food|restaur|delivery|caf/i, "🍽️"],
  [/transp|uber|taxi|nafta|combust|fuel|auto|car\b/i, "🚗"],
  [/vivienda|alquiler|rent|hogar|housing|expensas/i, "🏠"],
  [/software|herramient|tools|saas|app/i, "💻"],
  [/suscrip|subscr|streaming/i, "🔁"],
  [/educ|curso|capacit|course|training/i, "🎓"],
  [/salud|health|medic|farmac/i, "💊"],
  [/viaje|travel|vuelo|hotel/i, "✈️"],
  [/regalo|gift/i, "🎁"],
  [/publicidad|marketing|ads|anunci/i, "📣"],
  [/automatiz|automation|bot/i, "🤖"],
  [/servicio|profesional|consult|honorario/i, "💼"],
  [/sueldo|salario|salary|payroll/i, "💰"],
  [/cliente|venta|revenue|ingreso|cobro|income/i, "💵"],
  [/impuesto|tax|afip|iva/i, "🧾"],
  [/comision|fee|pasarela|banc/i, "🏦"],
  [/hosting|dominio|domain|server/i, "🌐"],
  [/hardware|equip/i, "🖥️"],
  [/mentor|coaching/i, "🧭"],
  [/video|edici/i, "🎬"],
  [/freelance/i, "🧑‍💻"],
  [/otro|other|vario/i, "📦"],
];

export function suggestCategoryIcon(name: string): string | null {
  return CATEGORY_ICONS.find(([re]) => re.test(name))?.[1] ?? null;
}

export const createCategoryInput = z
  .object({
    name: text(80).overwrite(normalizeEntityTitle),
    type: z.enum(["income", "expense", "both"]).default("expense"),
    parent: text(80).optional().describe("Parent category name, for a sub-category."),
    books: z.array(text(60)).max(10).optional().describe("Only offer it in these Books."),
    icon: emojiField.optional().describe("One emoji (🛒, 💻, 📣); omit to let ELISE suggest it."),
  })
  .strict();

export const saveBookInput = z
  .object({
    book: text(60).optional().describe("Existing Book to change (omit to create)."),
    name: text(60).overwrite(normalizeEntityTitle).optional(),
    type: z.enum(["personal", "business", "other"]).optional(),
    icon: z.string().trim().max(16).nullable().optional(),
    description: z.string().trim().max(300).nullable().optional(),
    reportingCurrency: currencyField.nullable().optional(),
    isDefault: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const setBudgetInput = z
  .object({
    category: text(80).describe("Expense category it limits."),
    subcategory: text(80).optional(),
    book: text(60).optional().describe("Ámbito; omit for the default Book."),
    amount: amountField.describe('Monthly amount ("200 lucas" → 200000).'),
    currency: currencyField.optional(),
    archived: z.boolean().optional().describe("true removes the budget."),
  })
  .strict();

export const budgetsInput = z
  .object({
    book: text(60).optional(),
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional()
      .describe("YYYY-MM; default this month."),
    onlyAtRisk: z.boolean().optional().describe("Only budgets at 80% or more."),
  })
  .strict();

export const setRateInput = z
  .object({
    from: currencyField,
    to: currencyField,
    rate: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .refine((v) => /^\d{1,12}(\.\d{1,8})?$/.test(v) && Number(v) > 0, "A positive rate"),
    date: isoDate.optional().describe("From when it applies; default today."),
  })
  .strict();

export const REPORT_SECTIONS = [
  "summary",
  "kpis",
  "trend",
  "categories",
  "budgets",
  "counterparties",
  "transactions",
  "notes",
  "receipts",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export const reportInput = z
  .object({
    ...filterFields,
    reportingCurrency: currencyField.optional().describe("Show converted totals in this currency."),
    sections: z
      .array(z.enum(REPORT_SECTIONS))
      .max(9)
      .optional()
      .describe("What to include; default everything but notes and receipts."),
  })
  .strict();
export type ReportInput = z.infer<typeof reportInput>;

export const DEFAULT_REPORT_SECTIONS: ReportSection[] = [
  "summary",
  "kpis",
  "trend",
  "categories",
  "budgets",
  "counterparties",
  "transactions",
];

/** Reasonable starters for a new workspace; users rename, add or archive freely. */
export const STARTER_CATEGORIES: Record<"es" | "en", { name: string; type: CategoryType }[]> = {
  en: [
    { name: "Food", type: "expense" },
    { name: "Groceries", type: "expense" },
    { name: "Transport", type: "expense" },
    { name: "Housing", type: "expense" },
    { name: "Software", type: "expense" },
    { name: "Subscriptions", type: "expense" },
    { name: "Education", type: "expense" },
    { name: "Health", type: "expense" },
    { name: "Travel", type: "expense" },
    { name: "Other", type: "expense" },
    { name: "Salary", type: "income" },
    { name: "Freelance", type: "income" },
    { name: "Clients", type: "income" },
    { name: "Other income", type: "income" },
  ],
  es: [
    { name: "Comida", type: "expense" },
    { name: "Supermercado", type: "expense" },
    { name: "Transporte", type: "expense" },
    { name: "Vivienda", type: "expense" },
    { name: "Software", type: "expense" },
    { name: "Suscripciones", type: "expense" },
    { name: "Educación", type: "expense" },
    { name: "Salud", type: "expense" },
    { name: "Viajes", type: "expense" },
    { name: "Otros", type: "expense" },
    { name: "Sueldo", type: "income" },
    { name: "Freelance", type: "income" },
    { name: "Clientes", type: "income" },
    { name: "Otros ingresos", type: "income" },
  ],
};

/** Resolves the period of a filter input: explicit dates win, then the preset, then this month. */
export function periodOf(
  input: { period?: PeriodPreset; from?: string; to?: string },
  today: string,
): Period {
  if (input.from || input.to) {
    const base = resolvePeriod("this_month", today);
    const from = input.from ?? input.to ?? base.from;
    const to = input.to ?? (input.from ? today : base.to);
    return from <= to ? { from, to } : { from: to, to: from };
  }
  return resolvePeriod(input.period ?? "this_month", today);
}

type FilterInput = { [K in keyof typeof filterFields]?: z.infer<(typeof filterFields)[K]> };

export function filterOf(input: FilterInput, period: Period): TransactionFilter {
  return {
    from: period.from,
    to: period.to,
    type: input.type,
    book: input.book,
    subcategory: input.subcategory,
    currencies: input.currency,
    category: input.category,
    account: input.account,
    counterparty: input.counterparty,
    project: input.project,
    paymentMethod: input.paymentMethod,
    text: input.text,
    statuses: input.status,
    source: input.source,
  };
}
