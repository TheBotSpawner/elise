import { z } from "zod";

import type { EntrySource } from "./habits";
import {
  addAmounts,
  averageAmount,
  compareAmounts,
  fromUnits,
  isDecimal,
  normalizeAmount,
  normalizeCurrency,
  percentChange,
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
import { addDays, isIsoDate } from "../time";

/**
 * Finance (docs/architecture/10 §20-26): structured income and expenses, not banking.
 * Every number the user sees is computed here from records — never by the model — and totals
 * are always per currency: USD and ARS are never added together without an explicit rate
 * (none is configured today, so none is ever applied).
 */

export type TransactionType = "income" | "expense";
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
}

export interface FinanceCategory {
  id: string;
  name: string;
  type: CategoryType;
  parentId: string | null;
  parent: string | null;
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
    c: { name: string; type: CategoryType; parentId: string | null },
    source: EntrySource,
  ): Promise<FinanceCategory>;
  settings(): Promise<{ defaultCurrency: string | null; reportingCurrency: string | null }>;
  /** Currencies used most recently, most used first (to ask "ARS or USD?"). */
  recentCurrencies(): Promise<string[]>;
  /** Archives what one import created; returns how many. */
  undoImport(importId: string): Promise<{ archived: number; label: string }>;
  describeImport(importId: string): Promise<{ label: string; imported: number } | null>;
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
    const hay = [t.description, t.counterparty, t.notes, t.category, t.subcategory, t.project]
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
  type: TransactionType;
  currency: string;
  total: string;
  count: number;
}

/** A compact transaction for results (no internal fields). */
export interface TransactionBrief {
  id: string;
  date: string;
  type: TransactionType;
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
}

export interface FinanceSummary {
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
    type: t.type,
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
  const matched = rows.filter((t) => matchesFilter(t, f));
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
      g: { key: category, type: t.type, currency: t.currency, count: 0 },
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
    for (const t of rows.filter((x) => matchesFilter(x, f))) {
      const key = groupKey(t, by);
      const k = `${t.type}|${t.currency}|${norm(key)}`;
      const cur = groups.get(k) ?? {
        units: 0n,
        g: { key, type: t.type, currency: t.currency, count: 0 },
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
  type: z.enum(["income", "expense"]).optional(),
  currency: z.array(currencyField).max(10).optional(),
  category: text(80).optional().describe("Category name; includes its sub-categories."),
  account: text(80).optional(),
  counterparty: text(200).optional().describe("Merchant, provider or client, e.g. OpenAI, Firbot."),
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
    type: z.enum(["income", "expense"]),
    amount: amountField,
    currency: currencyField.optional(),
    date: isoDate.optional().describe("Local date; default today."),
    description: text(300).optional(),
    counterparty: text(200).optional().describe("Who was paid or who paid: OpenAI, Firbot, Coto."),
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
    project: text(120).optional().describe('Project or client it belongs to ("ELISE", "RSFA").'),
    status: z.enum(["completed", "pending"]).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export const updateTransactionInput = z
  .object({
    transaction: transactionRef,
    type: z.enum(["income", "expense"]).optional(),
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
    name: text(80),
    type: z
      .enum(["cash", "bank", "credit_card", "debit_card", "digital_wallet", "business", "other"])
      .default("other"),
    currency: currencyField.optional(),
  })
  .strict();

export const updateAccountInput = z
  .object({
    account: text(80).describe("The account's current name."),
    name: text(80).optional(),
    type: z
      .enum(["cash", "bank", "credit_card", "debit_card", "digital_wallet", "business", "other"])
      .optional(),
    currency: currencyField.nullable().optional(),
    archived: z.boolean().optional().describe("true hides it from new records; history stays."),
  })
  .strict();

export const createCategoryInput = z
  .object({
    name: text(80),
    type: z.enum(["income", "expense", "both"]).default("expense"),
    parent: text(80).optional().describe("Parent category name, for a sub-category."),
  })
  .strict();

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
