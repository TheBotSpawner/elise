import "server-only";

import type { ToolDisplay } from "@/core/agents/tools";
import {
  PERIODS,
  reportInput,
  resolvePeriod,
  trendFromGroups,
  trendGranularity,
  type BudgetUsage,
  type FinanceAccount,
  type FinanceBook,
  type FinanceCategory,
  type FinanceSummary,
  type FinanceTransaction,
  type GroupTotal,
  type Period,
  type PeriodPreset,
  type ReportInput,
  type TrendSeries,
} from "@/core/capabilities/finance";
import { AppError } from "@/core/errors";
import { normalizeCurrency } from "@/core/finance/money";
import { todayIn } from "@/core/time";

import type { AuthContext } from "./auth-context";
import { runUserTool } from "./elise";
import { listFinanceImports } from "./finance-import";
import { financeGoogleAccounts, listFinanceSources } from "./finance-sources";

/**
 * Finance for My Elise → Finance. Reads and writes go through the same Finance tools Chat
 * uses (provider resolution, per-currency computation, policy, audit), so the screen and the
 * conversation always agree.
 */

export const FINANCE_TABS = ["movements", "analysis", "budgets"] as const;
export type FinanceTab = (typeof FINANCE_TABS)[number];

/** ADR-054: how the period is chosen (Día / Semana / Mes / Año) around an anchor date. */
export const FINANCE_GRANULARITIES = ["day", "week", "month", "year"] as const;
export type FinanceGranularity = (typeof FINANCE_GRANULARITIES)[number];

export interface FinanceFilters {
  tab: FinanceTab;
  /** A preset (chat links), "custom" (from/to), or "span": `gran` around `date`. */
  period: PeriodPreset | "custom" | "span";
  gran: FinanceGranularity;
  /** Anchor date for `gran`; absent = today. */
  date?: string;
  from?: string;
  to?: string;
  /** A Book id, or UNCLASSIFIED. Absent = all Books. */
  book?: string;
  q?: string;
  type?: "income" | "expense" | "transfer";
  category?: string;
  account?: string;
  currency?: string;
  source?: string;
  status?: "pending";
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseFinanceFilters(
  params: Record<string, string | string[] | undefined>,
): FinanceFilters {
  const one = (k: string) => {
    const v = params[k];
    const s = (Array.isArray(v) ? v[0] : v)?.trim();
    return s ? s.slice(0, 200) : undefined;
  };
  const period = one("period");
  const type = one("type");
  const currency = one("currency");
  const tab = one("tab");
  const from = one("from");
  const to = one("to");
  const custom = Boolean(from && to && ISO.test(from) && ISO.test(to) && from <= to);
  const gran = one("gran");
  const date = one("date");
  return {
    gran: (FINANCE_GRANULARITIES as readonly string[]).includes(gran ?? "")
      ? (gran as FinanceGranularity)
      : "month",
    ...(date && ISO.test(date) ? { date } : {}),
    tab: (FINANCE_TABS as readonly string[]).includes(tab ?? "")
      ? (tab as FinanceTab)
      : "movements",
    period: custom
      ? "custom"
      : (PERIODS as readonly string[]).includes(period ?? "")
        ? (period as PeriodPreset)
        : "span",
    ...(custom ? { from, to } : {}),
    book: one("book")?.slice(0, 60),
    q: one("q"),
    type: type === "income" || type === "expense" || type === "transfer" ? type : undefined,
    category: one("category"),
    account: one("account"),
    currency: currency ? (normalizeCurrency(currency) ?? undefined) : undefined,
    source: one("source"),
    status: one("status") === "pending" ? "pending" : undefined,
  };
}

/** The span of a granularity around a date: that day, its Mon–Sun week, month or year. */
export function spanOf(gran: FinanceGranularity, anchor: string): Period {
  if (gran === "day") return { from: anchor, to: anchor };
  if (gran === "week") return resolvePeriod("this_week", anchor);
  return resolvePeriod(gran === "year" ? "this_year" : "this_month", anchor);
}

export function periodOfFilters(f: FinanceFilters, today: string): Period {
  if (f.period === "custom" && f.from && f.to) return { from: f.from, to: f.to };
  if (f.period !== "custom" && f.period !== "span") return resolvePeriod(f.period, today);
  return spanOf(f.gran, f.date ?? today);
}

function display<K extends ToolDisplay["kind"]>(d: ToolDisplay | undefined, kind: K) {
  if (d?.kind !== kind) throw new AppError("INTERNAL_ERROR", `Expected ${kind}`);
  return d as Extract<ToolDisplay, { kind: K }>;
}

async function read<K extends ToolDisplay["kind"]>(
  auth: AuthContext,
  tool: string,
  args: unknown,
  kind: K,
) {
  const outcome = await runUserTool(auth, tool, args);
  return display(outcome.status === "succeeded" ? outcome.display : undefined, kind);
}

/** Extras (Books, budgets, analysis) never take the screen down: missing → hidden. */
const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export interface FinanceOverview {
  filters: FinanceFilters;
  period: Period;
  summary: FinanceSummary;
  trend: TrendSeries[];
  transactions: FinanceTransaction[];
  matching: number;
  accounts: FinanceAccount[];
  categories: FinanceCategory[];
  books: FinanceBook[];
  /** Statistics tab: clients, providers and projects. */
  analysis: { counterparties: GroupTotal[]; projects: GroupTotal[] } | null;
  /** Expenses and income per Book (all Books selected only). */
  byBook: GroupTotal[];
  /** Budgets of the period's month (today's month when the period includes today). */
  budgets: { month: string; usages: BudgetUsage[] } | null;
  settings: { defaultCurrency: string | null };
  /** Any transaction at all (ELISE or a connected sheet): onboarding only when there is none. */
  hasAny: boolean;
  today: string;
}

export async function financeOverview(
  auth: AuthContext,
  filters: FinanceFilters,
): Promise<FinanceOverview> {
  const today = todayIn(auth.profile.timezone);
  const period = periodOfFilters(filters, today);
  const shared = {
    from: period.from,
    to: period.to,
    ...(filters.book ? { book: filters.book } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.account ? { account: filters.account } : {}),
    ...(filters.currency ? { currency: [filters.currency] } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.q ? { text: filters.q } : {}),
  };
  const granularity = trendGranularity(period.from, period.to);
  const groups = (groupBy: string) =>
    read(auth, "finance.query", { ...shared, groupBy }, "finance_breakdown").then(
      (b) => b.breakdown.groups,
    );
  const analysis = filters.tab === "analysis";
  const budgetMonth = (period.from <= today && today <= period.to ? today : period.from).slice(
    0,
    7,
  );
  const [summary, trend, list, accounts, categories, books, settings, extra, budgets, byBook, any] =
    await Promise.all([
      read(auth, "finance.getSummary", { ...shared, compare: "previous" }, "finance_summary"),
      groups(granularity),
      read(
        auth,
        "finance.listTransactions",
        {
          ...shared,
          // Movements show what's still to be paid too; totals keep counting completed only.
          status: filters.status ? ["pending"] : ["completed", "pending"],
          limit: 100,
        },
        "finance_transactions",
      ),
      read(auth, "finance.listAccounts", {}, "finance_accounts"),
      read(auth, "finance.listCategories", {}, "finance_categories"),
      optional(read(auth, "finance.listBooks", {}, "finance_books")),
      auth.db
        .from("finance_settings")
        .select("default_currency")
        .eq("workspace_id", auth.workspaceId)
        .maybeSingle(),
      analysis ? optional(Promise.all([groups("counterparty"), groups("project")])) : null,
      optional(
        read(
          auth,
          "finance.getBudgets",
          { month: budgetMonth, ...(filters.book ? { book: filters.book } : {}) },
          "finance_budgets",
        ),
      ),
      filters.book ? Promise.resolve([]) : optional(groups("book")),
      hasAnyFinance(auth),
    ]);
  return {
    filters,
    period,
    summary: summary.summary,
    trend: trendFromGroups(trend, period, granularity),
    transactions: list.transactions,
    matching: list.total,
    accounts: accounts.accounts,
    categories: categories.categories,
    books: books?.books ?? [],
    analysis: extra
      ? { counterparties: extra[0], projects: extra[1] }
      : analysis
        ? { counterparties: [], projects: [] }
        : null,
    byBook: byBook ?? [],
    budgets: budgets ? { month: budgets.month, usages: budgets.budgets } : null,
    settings: { defaultCurrency: settings.data?.default_currency ?? null },
    hasAny: any || list.total > 0,
    today,
  };
}

/** Does this workspace have any finance data (ELISE or a connected sheet)? One cheap probe. */
async function hasAnyFinance(auth: AuthContext): Promise<boolean> {
  const [own, sheets] = await Promise.all([
    auth.db
      .from("finance_transactions")
      .select("id")
      .eq("workspace_id", auth.workspaceId)
      .is("archived_at", null)
      .limit(1),
    auth.db.from("finance_source_rows").select("id").eq("workspace_id", auth.workspaceId).limit(1),
  ]);
  return Boolean(own.data?.length || sheets.data?.length);
}

/**
 * A report's filters from its URL (preview page, PDF route and chat link share them). No dates
 * → the last 30 days. Invalid values are dropped, never guessed.
 */
export function parseReportParams(params: Record<string, string | string[] | undefined>) {
  const one = (k: string) => {
    const v = params[k];
    const s = (Array.isArray(v) ? v[0] : v)?.trim();
    return s ? s.slice(0, 200) : undefined;
  };
  const list = (k: string) => one(k)?.split(",").filter(Boolean);
  const from = one("from");
  const to = one("to");
  const dated = Boolean(from && to && ISO.test(from) && ISO.test(to) && from <= to);
  const raw = {
    ...(dated ? { from, to } : { period: "last_30_days" }),
    book: one("book")?.slice(0, 60),
    type: one("type"),
    category: one("category"),
    subcategory: one("subcategory"),
    account: one("account"),
    counterparty: one("counterparty"),
    project: one("project"),
    currency: list("currency"),
    status: list("status"),
    reportingCurrency: one("rc"),
    sections: list("sections"),
  };
  const parsed = reportInput.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)),
  );
  return parsed.success ? parsed.data : reportInput.parse({ period: "last_30_days" });
}

/** The report dataset: the same tool (and numbers) as ELISE's chat answer and the PDF. */
export async function financeReport(auth: AuthContext, input: ReportInput) {
  const d = await read(auth, "finance.createReport", input, "finance_report");
  return d.report;
}

export async function financeSourcesOverview(auth: AuthContext) {
  const [sources, imports, googleAccounts] = await Promise.all([
    listFinanceSources(auth),
    listFinanceImports(auth),
    financeGoogleAccounts(auth),
  ]);
  return { sources, imports, googleAccounts };
}

export async function setFinanceDefaultCurrency(auth: AuthContext, currency: string | null) {
  const code = currency ? normalizeCurrency(currency) : null;
  if (currency && !code)
    throw new AppError("VALIDATION_ERROR", "Use a currency code like ARS or USD");
  const { error } = await auth.db
    .from("finance_settings")
    .upsert(
      { workspace_id: auth.workspaceId, default_currency: code },
      { onConflict: "workspace_id" },
    );
  if (error) throw new AppError("INTERNAL_ERROR", "Could not save the setting", { cause: error });
}

/** The workspace's Books (empty before the Finance v2 database update). */
export async function financeBooks(auth: AuthContext): Promise<FinanceBook[]> {
  const d = await optional(read(auth, "finance.listBooks", {}, "finance_books"));
  return d?.books ?? [];
}
