import "server-only";

import type { ToolDisplay } from "@/core/agents/tools";
import {
  PERIODS,
  type FinanceAccount,
  type FinanceBreakdown,
  type FinanceCategory,
  type FinanceSummary,
  type FinanceTransaction,
  type PeriodPreset,
} from "@/core/capabilities/finance";
import { AppError } from "@/core/errors";
import { normalizeCurrency } from "@/core/finance/money";
import { addDays, todayIn } from "@/core/time";

import type { AuthContext } from "./auth-context";
import { runUserTool } from "./elise";
import { listFinanceImports } from "./finance-import";
import { financeGoogleAccounts, listFinanceSources } from "./finance-sources";

/**
 * Finance for My Elise → Finance. Reads and writes go through the same Finance tools Chat
 * uses (provider resolution, per-currency computation, policy, audit), so the screen and the
 * conversation always agree.
 */

export interface FinanceFilters {
  period: PeriodPreset;
  q?: string;
  type?: "income" | "expense";
  category?: string;
  account?: string;
  currency?: string;
  source?: string;
}

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
  return {
    period: (PERIODS as readonly string[]).includes(period ?? "")
      ? (period as PeriodPreset)
      : "this_month",
    q: one("q"),
    type: type === "income" || type === "expense" ? type : undefined,
    category: one("category"),
    account: one("account"),
    currency: currency ? (normalizeCurrency(currency) ?? undefined) : undefined,
    source: one("source"),
  };
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

export interface FinanceOverview {
  filters: FinanceFilters;
  summary: FinanceSummary;
  trend: FinanceBreakdown;
  transactions: FinanceTransaction[];
  matching: number;
  accounts: FinanceAccount[];
  categories: FinanceCategory[];
  settings: { defaultCurrency: string | null };
}

export async function financeOverview(
  auth: AuthContext,
  filters: FinanceFilters,
): Promise<FinanceOverview> {
  const shared = {
    period: filters.period,
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.account ? { account: filters.account } : {}),
    ...(filters.currency ? { currency: [filters.currency] } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.q ? { text: filters.q } : {}),
  };
  const today = todayIn(auth.profile.timezone);
  const trendFrom = `${addDays(`${today.slice(0, 7)}-01`, -150).slice(0, 7)}-01`;
  const [summary, trend, list, accounts, categories, settings] = await Promise.all([
    read(auth, "finance.getSummary", { ...shared, compare: "previous" }, "finance_summary"),
    read(
      auth,
      "finance.query",
      { ...shared, period: undefined, from: trendFrom, to: today, groupBy: "month" },
      "finance_breakdown",
    ),
    read(auth, "finance.listTransactions", { ...shared, limit: 100 }, "finance_transactions"),
    read(auth, "finance.listAccounts", {}, "finance_accounts"),
    read(auth, "finance.listCategories", {}, "finance_categories"),
    auth.db
      .from("finance_settings")
      .select("default_currency")
      .eq("workspace_id", auth.workspaceId)
      .maybeSingle(),
  ]);
  return {
    filters,
    summary: summary.summary,
    trend: trend.breakdown,
    transactions: list.transactions,
    matching: list.total,
    accounts: accounts.accounts,
    categories: categories.categories,
    settings: { defaultCurrency: settings.data?.default_currency ?? null },
  };
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
