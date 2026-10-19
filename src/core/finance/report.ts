import {
  budgetBookIds,
  budgetUsage,
  computeBreakdown,
  computeTotals,
  convertTotals,
  matchesFilter,
  topWithOther,
  trendSeries,
  type Budget,
  type BudgetUsage,
  type ConvertedTotals,
  type CurrencyTotals,
  type FinanceSourceInfo,
  type FinanceTransaction,
  type FxRate,
  type GroupTotal,
  type ReportSection,
  type TransactionFilter,
  type TrendSeries,
} from "../capabilities/finance";
import type { Period } from "../periods";
import { multiplyByRate } from "./money";

/**
 * A financial report (ADR-052): one deterministic dataset from the filtered ledger. The preview
 * on screen, the PDF and ELISE's answer are all built from this — never from model arithmetic.
 */

export interface FinanceReport {
  period: Period;
  /** The Book in scope, or null for every Book. */
  book: string | null;
  filter: TransactionFilter;
  sections: ReportSection[];
  totals: CurrencyTotals[];
  converted: ConvertedTotals | null;
  trend: TrendSeries[];
  expenseCategories: GroupTotal[];
  incomeCategories: GroupTotal[];
  clients: GroupTotal[];
  providers: GroupTotal[];
  projects: GroupTotal[];
  budgets: BudgetUsage[];
  /** Months the budgets cover (a budget is monthly: its limit × months in range). */
  budgetMonths: number;
  transactions: FinanceTransaction[];
  transfers: number;
  excluded: { pending: number; cancelled: number };
  sources: FinanceSourceInfo[];
  truncated: boolean;
}

const TOP = 8;

/** Whole calendar months touched by the range (a budget limit applies per month). */
export function monthsIn(period: Period): string[] {
  const out: string[] = [];
  let [y, m] = period.from.slice(0, 7).split("-").map(Number) as [number, number];
  const end = period.to.slice(0, 7);
  for (let i = 0; i < 120; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    if (m === 12) {
      y += 1;
      m = 1;
    } else m += 1;
  }
  return out;
}

export function buildFinanceReport(input: {
  rows: FinanceTransaction[];
  filter: TransactionFilter & Period;
  sections: ReportSection[];
  book: string | null;
  budgets: Budget[];
  rates: FxRate[];
  reportingCurrency: string | null;
  sources: FinanceSourceInfo[];
  truncated: boolean;
}): FinanceReport {
  const { rows, filter } = input;
  const totals = computeTotals(rows, filter);
  const byCategory = computeBreakdown(rows, filter, "category", [], false).groups;
  const byWho = computeBreakdown(rows, filter, "counterparty", [], false).groups;
  const byProject = computeBreakdown(rows, filter, "project", [], false).groups;
  // Every currency gets its own ranking: never merged, never dropped.
  const currencies = totals.totals.map((c) => c.currency);
  const pick = (groups: GroupTotal[], type: "income" | "expense") =>
    currencies.flatMap((c) =>
      topWithOther(
        groups.filter((g) => g.type === type && g.currency === c && g.key !== "—"),
        TOP,
        "Otros",
      ),
    );
  const months = monthsIn(filter);
  const budgets = input.budgets
    .filter(
      (b) =>
        !input.book ||
        budgetBookIds(b).includes(filter.book ?? "") ||
        (b.books ?? (b.book ? [b.book] : [])).includes(input.book),
    )
    .map((b) => {
      const scaled = { ...b, amount: multiplyByRate(b.amount, String(months.length)) };
      return budgetUsage(
        scaled,
        rows.filter((t) => t.date >= filter.from && t.date <= filter.to),
      );
    });
  return {
    period: { from: filter.from, to: filter.to },
    book: input.book,
    filter,
    sections: input.sections,
    totals: totals.totals,
    converted: input.reportingCurrency
      ? convertTotals(rows, filter, input.reportingCurrency, input.rates)
      : null,
    trend: trendSeries(rows, filter),
    expenseCategories: pick(byCategory, "expense"),
    incomeCategories: pick(byCategory, "income"),
    clients: pick(byWho, "income"),
    providers: pick(byWho, "expense"),
    projects: currencies.flatMap((c) =>
      byProject.filter((g) => g.currency === c && g.key !== "—").slice(0, TOP),
    ),
    budgets,
    budgetMonths: months.length,
    transactions: rows
      .filter((t) =>
        matchesFilter(t, { ...filter, statuses: filter.statuses ?? ["completed", "pending"] }),
      )
      .sort((a, b) => a.date.localeCompare(b.date)),
    transfers: totals.transfers ?? 0,
    excluded: totals.excluded,
    sources: input.sources,
    truncated: input.truncated,
  };
}
