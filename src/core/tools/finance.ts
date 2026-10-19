import { z } from "zod";

import { pickOne, sourceOf } from "./native-common";
import type { ToolDefinition, ToolRunEnv, ToolRunResult } from "../agents/tools";
import {
  budgetUsage,
  budgetsInput,
  comparisonPeriod,
  computeBreakdown,
  computeTotals,
  convertTotals,
  DEFAULT_REPORT_SECTIONS,
  reportInput,
  saveBookInput,
  setBudgetInput,
  setRateInput,
  suggestCategoryIcon,
  UNCLASSIFIED,
  updateCategoryInput,
  deleteCategoryInput,
  type ConvertedTotals,
  type FinanceBook,
  createAccountInput,
  createCategoryInput,
  updateAccountInput,
  createTransactionInput,
  filterOf,
  finalizeSummary,
  listTransactionsInput,
  matchesFilter,
  mergeBreakdowns,
  mergeSummaries,
  mergeTransactionLists,
  norm,
  periodOf,
  queryInput,
  summaryInput,
  transactionRef,
  updateTransactionInput,
  type FinanceAccount,
  type FinanceBreakdown,
  type FinanceCategory,
  type FinanceProvider,
  type FinanceSummary,
  type FinanceTransaction,
  type TransactionPatch,
  type TransactionType,
} from "../capabilities/finance";
import { isSingleEmoji } from "../emoji";
import { AppError } from "../errors";
import { cleanCategoryName, duplicateCategory, planCombine } from "../finance/combine";
import { addAmounts, formatMoney } from "../finance/money";
import { buildFinanceReport } from "../finance/report";
import { resolvePeriod } from "../periods";
import { parseExternalRef } from "../providers/refs";
import { normalizeEntityTitle } from "../text";
import { todayIn } from "../time";

/**
 * Finance tools (docs/architecture/10 §20-26). Canonical and provider-independent: the resolver
 * decides whether ELISE Finance, a connected Google Sheet or both answer. Every total is
 * computed by ELISE per currency; the model only explains the numbers it receives.
 */

/** Most rows one source may load for a single question (a year of personal finances fits). */
export const MAX_ROWS = 20_000;

function provider(env: ToolRunEnv): FinanceProvider {
  return env.providers.get("finance", env.binding);
}

const today = (env: ToolRunEnv) => todayIn(env.ctx.timezone, env.ctx.now);

/** Native records are routed to ELISE; rows of a connected sheet name their account. */
function routeRef(ref: string) {
  const external = parseExternalRef(ref);
  return external
    ? { connectionId: external.connectionId }
    : { providerKey: "elise_native" as const };
}

const nativeOnly = () => ({ providerKey: "elise_native" as const });

function findByName<T>(items: T[], ref: string, name: (t: T) => string): T[] {
  const wanted = norm(ref);
  const exact = items.filter((i) => norm(name(i)) === wanted);
  if (exact.length) return exact;
  return items.filter((i) => {
    const n = norm(name(i));
    return n.includes(wanted) || (n.length >= 3 && wanted.includes(n));
  });
}

function money(amount: string, currency: string, locale: string) {
  return formatMoney(amount, currency, locale === "es" ? "es-AR" : "en-US");
}

const txForModel = (t: FinanceTransaction) => ({
  id: t.id,
  date: t.date,
  type: t.type,
  amount: t.amount,
  currency: t.currency,
  counterparty: t.counterparty,
  description: t.description,
  category: t.category,
  account: t.account ?? t.paymentMethod,
  project: t.project,
  status: t.status,
  ...((t.books?.length ?? 0) > 1
    ? { books: t.books }
    : t.book
      ? { book: t.book }
      : t.bookId === null
        ? { book: "Sin clasificar" }
        : {}),
  ...(t.subcategory ? { subcategory: t.subcategory } : {}),
  ...(t.type === "transfer" ? { toAccount: t.toAccount } : {}),
  ...(t.receipt ? { receipt: t.receipt } : {}),
  source: t.provenance.source,
  ...(t.readOnly ? { readOnly: true } : {}),
});

// ── Reads ────────────────────────────────────────────────────────────────────

function showSummary(summary: FinanceSummary): ToolRunResult<unknown> {
  const multiCurrency = summary.current.totals.length > 1;
  return {
    output: {
      period: summary.period,
      comparedWith: summary.comparison,
      // Per currency, exactly as computed. Never add different currencies together.
      totals: summary.current.totals,
      ...(multiCurrency
        ? {
            note: "Several currencies: report each total separately; no exchange rate is configured.",
          }
        : {}),
      previousTotals: summary.previous?.totals ?? null,
      changesPercent: summary.changes,
      topCategories: summary.current.byCategory
        .filter((c) => c.type === "expense")
        .slice(0, 8)
        .map((c) => ({ category: c.key, currency: c.currency, total: c.total, count: c.count })),
      incomeBySource: summary.current.byCategory
        .filter((c) => c.type === "income")
        .slice(0, 5)
        .map((c) => ({ category: c.key, currency: c.currency, total: c.total })),
      largest: summary.current.largest.slice(0, 5),
      ...(summary.converted
        ? {
            converted: summary.converted,
            conversionNote:
              "Converted at the user's dated rates (each transaction at the rate on/before its date). Say which rates were used; never add currencies yourself.",
          }
        : {}),
      ...(summary.current.transfers ? { transfersNotCounted: summary.current.transfers } : {}),
      insights: summary.insights,
      transactions: summary.current.count,
      excluded: summary.current.excluded,
      sources: summary.sources.map((s) => ({
        name: s.name,
        ...(s.lastSyncedAt ? { syncedAt: s.lastSyncedAt } : {}),
      })),
      ...(summary.truncated ? { partial: true } : {}),
    },
    display: { kind: "finance_summary", summary },
  };
}

export const getSummaryTool: ToolDefinition = {
  name: "finance.getSummary",
  capability: "finance",
  operation: "getSummary",
  description:
    '"¿Cuánto gasté este mes?", "my September summary", "this month vs last month", "Q3 vs Q2": income, expenses and net PER CURRENCY, top categories, largest transactions, change vs the comparison period and grounded insights. Filters narrow it (category, counterparty, project…). Use it instead of adding numbers yourself.',
  input: summaryInput,
  async describe() {
    return { summary: "Finance summary" };
  },
  async run(raw, env) {
    const input = summaryInput.parse(raw);
    const period = periodOf(input, today(env));
    const comparison = input.compare === "none" ? null : comparisonPeriod(period, input.compare);
    const filter = filterOf(input, period);
    const p = provider(env);
    const fetchFilter = { ...filter, statuses: undefined };
    const [current, previous, sources, rates] = await Promise.all([
      p.transactions(fetchFilter, MAX_ROWS),
      comparison
        ? p.transactions({ ...fetchFilter, from: comparison.from, to: comparison.to }, MAX_ROWS)
        : null,
      p.sources(),
      input.reportingCurrency ? (p.listRates?.() ?? Promise.resolve([])) : Promise.resolve([]),
    ]);
    return showSummary({
      ...finalizeSummary({
        period,
        comparison,
        current: computeTotals(current.rows, filter),
        previous:
          previous && comparison
            ? computeTotals(previous.rows, { ...filter, ...comparison })
            : null,
        sources: relevantSources(sources, filter.source),
        truncated: current.truncated || Boolean(previous?.truncated),
      }),
      converted: input.reportingCurrency
        ? convertTotals(current.rows, filter, input.reportingCurrency, rates)
        : null,
    });
  },
  merge(results) {
    const summaries = results.map((r) => (r.result.display as { summary: FinanceSummary }).summary);
    return showSummary({
      ...mergeSummaries(summaries),
      converted: mergeConverted(summaries.map((s) => s.converted ?? null)),
    });
  },
};

/** Converted totals of several sources (same target currency): summed, rates unioned. */
function mergeConverted(parts: (ConvertedTotals | null)[]): ConvertedTotals | null {
  const present = parts.filter((p): p is ConvertedTotals => p !== null);
  if (!present.length) return null;
  const unconverted = new Map<string, number>();
  for (const p of present)
    for (const u of p.unconverted)
      unconverted.set(u.currency, (unconverted.get(u.currency) ?? 0) + u.count);
  return {
    currency: present[0]!.currency,
    income: addAmounts(...present.map((p) => p.income)),
    expense: addAmounts(...present.map((p) => p.expense)),
    net: addAmounts(...present.map((p) => p.net)),
    ratesUsed: [
      ...new Map(
        present.flatMap((p) => p.ratesUsed).map((r) => [`${r.from}|${r.to}|${r.date}`, r]),
      ).values(),
    ],
    unconverted: [...unconverted.entries()].map(([currency, count]) => ({ currency, count })),
  };
}

function relevantSources(sources: Awaited<ReturnType<FinanceProvider["sources"]>>, named?: string) {
  return sources.filter((s) =>
    named ? norm(s.name).includes(norm(named)) || norm(named).includes(norm(s.name)) : s.included,
  );
}

function showBreakdown(b: FinanceBreakdown): ToolRunResult<unknown> {
  return {
    output: {
      period: b.period,
      groupBy: b.groupBy,
      totals: b.totals,
      ...(b.totals.length > 1 ? { note: "Totals are per currency; never add them together." } : {}),
      groups: b.groups.slice(0, 60),
      ...(b.groups.length > 60 ? { moreGroups: b.groups.length - 60 } : {}),
      transactions: b.count,
      excluded: b.excluded,
      sources: b.sources.map((s) => s.name),
      ...(b.truncated ? { partial: true } : {}),
    },
    display: { kind: "finance_breakdown", breakdown: b },
  };
}

export const queryTool: ToolDefinition = {
  name: "finance.query",
  capability: "finance",
  operation: "query",
  description:
    '"¿Cuánto gasté en software en septiembre?", "gastos por categoría", "ingresos de Acme por mes", "USD vs ARS": deterministic filtered totals, optionally grouped (category, month, account, counterparty, project, source, currency…). Totals are per currency.',
  input: queryInput,
  async describe() {
    return { summary: "Finance query" };
  },
  async run(raw, env) {
    const input = queryInput.parse(raw);
    const period = periodOf(input, today(env));
    const filter = filterOf(input, period);
    const p = provider(env);
    const [page, sources] = await Promise.all([
      p.transactions({ ...filter, statuses: undefined }, MAX_ROWS),
      p.sources(),
    ]);
    return showBreakdown(
      computeBreakdown(
        page.rows,
        { ...filter, ...period },
        input.groupBy ?? null,
        relevantSources(sources, filter.source),
        page.truncated,
      ),
    );
  },
  merge(results) {
    return showBreakdown(
      mergeBreakdowns(
        results.map((r) => (r.result.display as { breakdown: FinanceBreakdown }).breakdown),
      ),
    );
  },
};

function showList(
  rows: FinanceTransaction[],
  total: number,
  possibleDuplicates: number,
): ToolRunResult<unknown> {
  return {
    output: {
      transactions: rows.map(txForModel),
      shown: rows.length,
      matching: total,
      ...(possibleDuplicates
        ? {
            possibleDuplicates,
            note: "Some records look identical in two sources; mention it instead of counting them twice.",
          }
        : {}),
    },
    display: { kind: "finance_transactions", transactions: rows, total },
  };
}

export const listTransactionsTool: ToolDefinition = {
  name: "finance.listTransactions",
  capability: "finance",
  operation: "listTransactions",
  description:
    '"Mostrame mis gastos recientes", "mis mayores gastos del mes": transactions newest first (or filter + read "largest" from finance.getSummary for the biggest). Each says which source it came from.',
  input: listTransactionsInput,
  async describe() {
    return { summary: "List transactions" };
  },
  async run(raw, env) {
    const input = listTransactionsInput.parse(raw);
    const hasDates = input.period || input.from || input.to;
    const period = hasDates
      ? periodOf(input, today(env))
      : { from: "1900-01-01", to: "2999-12-31" };
    const filter = {
      ...filterOf(input, period),
      statuses: input.status ?? (["completed", "pending"] as const).slice(),
    };
    const page = await provider(env).transactions(filter, hasDates ? MAX_ROWS : 2_000);
    const rows = page.rows.filter((t) => matchesFilter(t, filter));
    const merged = mergeTransactionLists([rows], input.limit);
    return {
      ...showList(merged.rows, merged.total, 0),
      // Kept whole for merging across sources; the model sees only `limit`.
      display: {
        kind: "finance_transactions",
        transactions: rows.slice(0, 100),
        total: rows.length,
      },
    };
  },
  merge(results, raw) {
    const input = listTransactionsInput.parse(raw);
    const lists = results.map(
      (r) => (r.result.display as { transactions: FinanceTransaction[] }).transactions,
    );
    const total = results.reduce(
      (n, r) => n + ((r.result.display as { total?: number }).total ?? 0),
      0,
    );
    const merged = mergeTransactionLists(lists, input.limit);
    return showList(merged.rows, total, merged.possibleDuplicates);
  },
};

const getInput = z.object({ transaction: transactionRef }).strict();

export const getTransactionTool: ToolDefinition = {
  name: "finance.getTransaction",
  capability: "finance",
  operation: "getTransaction",
  description: "One transaction by id, with its source.",
  input: getInput,
  route: (input: z.infer<typeof getInput>) => routeRef(input.transaction),
  async describe() {
    return { summary: "Open transaction" };
  },
  async run(raw, env) {
    const t = await provider(env).getTransaction(getInput.parse(raw).transaction);
    if (!t) throw new AppError("NOT_FOUND", "Transaction not found", { recovery: "review" });
    return {
      output: { transaction: { ...txForModel(t), notes: t.notes, subcategory: t.subcategory } },
      display: { kind: "finance_transaction", transaction: t, change: "shown" },
    };
  },
};

export const listAccountsTool: ToolDefinition = {
  name: "finance.listAccounts",
  capability: "finance",
  operation: "listAccounts",
  description: "The user's accounts and payment sources (Cash ARS, Visa, PayPal…), with currency.",
  input: z.object({}).strict(),
  route: nativeOnly,
  async describe() {
    return { summary: "List accounts" };
  },
  async run(_raw, env) {
    const accounts = await provider(env).listAccounts();
    return {
      output: { accounts: accounts.map(({ name, type, currency }) => ({ name, type, currency })) },
      display: { kind: "finance_accounts", accounts },
    };
  },
};

export const listCategoriesTool: ToolDefinition = {
  name: "finance.listCategories",
  capability: "finance",
  operation: "listCategories",
  description: "Finance categories (expense/income, with parents). Use their exact names.",
  input: z.object({}).strict(),
  route: nativeOnly,
  async describe() {
    return { summary: "List categories" };
  },
  async run(_raw, env) {
    const categories = await provider(env).listCategories();
    return {
      output: {
        categories: categories.map((c) => ({ name: c.name, type: c.type, parent: c.parent })),
      },
      display: { kind: "finance_categories", categories },
    };
  },
};

// ── Writes (ELISE Finance; connected sheets are read-only) ───────────────────

function writable(env: ToolRunEnv): FinanceProvider {
  const p = provider(env);
  if (p.readOnly) {
    throw new AppError(
      "PERMISSION_DENIED",
      "Connected Google Sheets are read-only in ELISE: change it in the sheet.",
      { recovery: "review" },
    );
  }
  return p;
}

function resolveCategory(
  categories: FinanceCategory[],
  name: string,
  type: TransactionType,
): FinanceCategory[] {
  const compatible = categories.filter(
    (c) => type === "transfer" || c.type === type || c.type === "both",
  );
  return findByName(compatible, name, (c) => c.name);
}

/** A Book by name ("Empresa", "personal"); several or none → the model asks, never guesses. */
async function resolveBook(p: FinanceProvider, name: string): Promise<FinanceBook> {
  const books = (await p.listBooks?.()) ?? [];
  const matches = findByName(books, name, (b) => b.name);
  if (matches.length === 1) return matches[0]!;
  throw new AppError(
    "VALIDATION_ERROR",
    matches.length
      ? `Several Books match "${name}": ${matches.map((b) => b.name).join(", ")}. Ask which one.`
      : `There's no Book called "${name}". Books: ${books.map((b) => b.name).join(", ") || "none"}. Ask the user (or create it with finance.saveBook if they want).`,
    { recovery: "review" },
  );
}

async function currencyFor(
  p: FinanceProvider,
  explicit: string | undefined,
  account: FinanceAccount | null,
): Promise<string> {
  if (explicit) return explicit;
  if (account?.currency) return account.currency;
  const [settings, recent] = await Promise.all([p.settings(), p.recentCurrencies()]);
  if (settings.defaultCurrency) return settings.defaultCurrency;
  if (recent.length === 1) return recent[0]!;
  const options = (recent.length ? recent : ["ARS", "USD"]).slice(0, 4).join(" or ");
  throw new AppError(
    "VALIDATION_ERROR",
    `The currency is ambiguous. Ask the user: ${options}? (No default currency is set.)`,
    { recovery: "review" },
  );
}

const stem = (w: string) => norm(w).replace(/(es|s)$/, "");

/** The one category of this type whose name appears in the text (singular or plural). */
export function categoryNamedIn(
  categories: readonly FinanceCategory[],
  text: string,
  type: "income" | "expense",
): FinanceCategory | null {
  const words = new Set(
    text
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4)
      .map(stem),
  );
  const hits = categories.filter(
    (c) =>
      (c.type === type || c.type === "both") &&
      c.name
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4)
        .some((w) => words.has(stem(w))),
  );
  return hits.length === 1 ? hits[0]! : null;
}

interface Resolved {
  patch: TransactionPatch;
  notes: string[];
}

/** Account, category and currency by name, the same way for create and update. */
async function resolveNames(
  p: FinanceProvider,
  input: {
    type: TransactionType;
    currency?: string;
    category?: string | null;
    categoryInferred?: boolean;
    account?: string | null;
    paymentMethod?: string | null;
    book?: string | null;
    books?: string[];
    toAccount?: string | null;
    /** What the movement is about: names an existing category when none was given. */
    about?: string | null;
  },
  env: ToolRunEnv,
  needCurrency: boolean,
  creating = false,
): Promise<Resolved> {
  const notes: string[] = [];
  const patch: TransactionPatch = {};
  let account: FinanceAccount | null = null;
  if (input.toAccount) {
    patch.toAccountId = pickOne(
      findByName(await p.listAccounts(), input.toAccount, (a) => a.name),
      input.toAccount,
      "account",
      (a) => a.name,
    ).id;
  } else if (input.toAccount === null) patch.toAccountId = null;
  if (input.account) {
    const matches = findByName(await p.listAccounts(), input.account, (a) => a.name);
    if (matches.length === 1) {
      account = matches[0]!;
      patch.accountId = account.id;
    } else if (matches.length > 1) {
      pickOne(matches, input.account, "account", (a) => a.name);
    } else {
      // Not an account yet: keep what the user said as the payment method, don't invent one.
      patch.accountId = null;
      patch.paymentMethod = input.paymentMethod ?? input.account;
      notes.push(`"${input.account}" is not an account; saved as payment method.`);
    }
  } else if (input.account === null) patch.accountId = null;
  else if (creating && input.type !== "transfer" && !input.paymentMethod) {
    // None said: the default account (ADR-087), which also brings its currency and Ámbito.
    const fallback = (await p.listAccounts()).find((a) => a.isDefault);
    if (fallback) {
      account = fallback;
      patch.accountId = fallback.id;
      notes.push(`No account said: used the default account "${fallback.name}".`);
    }
  }
  if (input.paymentMethod !== undefined && patch.paymentMethod === undefined)
    patch.paymentMethod = input.paymentMethod;

  if (input.category) {
    const categories = await p.listCategories();
    const matches = resolveCategory(categories, input.category, input.type);
    const exact = matches.filter((c) => norm(c.name) === norm(input.category!));
    const chosen = exact.length === 1 ? exact[0]! : matches.length === 1 ? matches[0]! : null;
    if (chosen) patch.categoryId = chosen.id;
    else if (matches.length > 1) pickOne(matches, input.category, "category", (c) => c.name);
    else if (input.categoryInferred) {
      patch.categoryId = null;
      notes.push(`No category matches "${input.category}"; left uncategorized.`);
    } else {
      // The user named it: create it instead of losing it.
      const created = await p.createCategory(
        {
          name: input.category,
          type: input.type === "transfer" ? "both" : input.type,
          parentId: null,
        },
        sourceOf(env.ctx),
      );
      patch.categoryId = created.id;
      notes.push(`Created category "${created.name}".`);
    }
  } else if (input.category === null) patch.categoryId = null;
  else if (creating && input.about && input.type !== "transfer") {
    // None given: an existing category the description names ("regalo Cande" → Regalos).
    const named = categoryNamedIn(await p.listCategories(), input.about, input.type);
    if (named) {
      patch.categoryId = named.id;
      notes.push(`Category "${named.name}" inferred from the description; say it.`);
    }
  }

  if (needCurrency || input.currency)
    patch.currency = await currencyFor(p, input.currency, account);

  // Ámbito: what the user said, else the account's default, else the default Book.
  if (input.books) {
    const ids: string[] = [];
    for (const name of input.books) ids.push((await resolveBook(p, name)).id);
    patch.bookIds = [...new Set(ids)];
    patch.bookId = patch.bookIds[0] ?? null;
  } else if (input.book === null) patch.bookId = null;
  else if (input.book) patch.bookId = (await resolveBook(p, input.book)).id;
  else if (creating && p.listBooks) {
    const books = await p.listBooks();
    patch.bookId =
      (account?.defaultBookId && books.some((b) => b.id === account!.defaultBookId)
        ? account.defaultBookId
        : books.find((b) => b.isDefault)?.id) ?? null;
  }
  return { patch, notes };
}

function showTransaction(
  t: FinanceTransaction,
  change: "created" | "updated" | "archived",
  notes: string[],
  extra: Record<string, unknown> = {},
): ToolRunResult<unknown> {
  return {
    output: {
      [change]: true,
      transaction: txForModel(t),
      ...(notes.length ? { notes } : {}),
      ...extra,
    },
    display: { kind: "finance_transaction", transaction: t, change },
    target: { type: "finance_transaction", id: t.id },
  };
}

export const createTransactionTool: ToolDefinition = {
  name: "finance.createTransaction",
  capability: "finance",
  operation: "createTransaction",
  description:
    'Record an expense, income or internal transfer (bookkeeping only: no money moves). "Gasté 42 lucas en Meta Ads con la tarjeta de la empresa" → expense, 42000, book Empresa, counterparty Meta, category Publicidad, subcategory Meta Ads, account "tarjeta de la empresa" (categoryInferred). "lucas" = thousands. Omit currency/book when not said: ELISE uses the account or default, or tells you to ask. Transfers need account and toAccount. Amount uses "." for decimals ("$48.000" → "48000").',
  input: createTransactionInput,
  async describe(raw, env) {
    const c = createTransactionInput.parse(raw);
    const who = c.counterparty ?? c.description ?? c.category ?? "";
    return {
      summary: `Record ${c.type} ${c.currency ? money(c.amount, c.currency, env.ctx.locale) : c.amount}${who ? ` · ${who}` : ""}`,
    };
  },
  async run(raw, env) {
    const c = createTransactionInput.parse(raw);
    const p = writable(env);
    const { patch, notes } = await resolveNames(
      p,
      { ...c, about: [c.description, c.counterparty].filter(Boolean).join(" ") },
      env,
      true,
      true,
    );
    if (c.type === "transfer" && (!patch.accountId || !patch.toAccountId))
      throw new AppError(
        "VALIDATION_ERROR",
        "A transfer needs both accounts (from and to): ask which ones.",
        { recovery: "review" },
      );
    const t = await p.createTransaction(
      {
        type: c.type,
        amount: c.amount,
        currency: patch.currency!,
        date: c.date ?? today(env),
        description: c.description ? normalizeEntityTitle(c.description) : null,
        counterparty: c.counterparty ?? null,
        categoryId: patch.categoryId ?? null,
        subcategory: c.subcategory ?? null,
        accountId: patch.accountId ?? null,
        paymentMethod: patch.paymentMethod ?? c.paymentMethod ?? null,
        project: c.project ?? null,
        status: c.status ?? "completed",
        notes: c.notes ?? null,
        bookId: patch.bookId ?? null,
        ...(patch.bookIds ? { bookIds: patch.bookIds } : {}),
        toAccountId: patch.toAccountId ?? null,
        receipt: c.receipt ?? null,
      },
      sourceOf(env.ctx),
    );
    return showTransaction(
      t,
      "created",
      notes,
      c.categoryInferred && t.category ? { categoryInferred: true } : {},
    );
  },
};

async function existing(env: ToolRunEnv, ref: string) {
  const t = await provider(env).getTransaction(ref);
  if (!t) throw new AppError("NOT_FOUND", "Transaction not found", { recovery: "review" });
  if (t.readOnly) {
    throw new AppError(
      "PERMISSION_DENIED",
      `This comes from ${t.provenance.source} (a connected Google Sheet): edit it in the sheet.`,
      { recovery: "review" },
    );
  }
  return t;
}

export const updateTransactionTool: ToolDefinition = {
  name: "finance.updateTransaction",
  capability: "finance",
  operation: "updateTransaction",
  description:
    'Correct a transaction ("era 30, no 25", "ponelo en el proyecto ELISE"). Pass only what changes; null clears a field.',
  input: updateTransactionInput,
  route: (input: z.infer<typeof updateTransactionInput>) => routeRef(input.transaction),
  async describe(raw, env) {
    const t = await existing(env, updateTransactionInput.parse(raw).transaction);
    return {
      summary: `Edit ${t.type} ${money(t.amount, t.currency, env.ctx.locale)} · ${t.counterparty ?? t.description ?? t.date}`,
      target: { type: "finance_transaction", id: t.id },
    };
  },
  async run(raw, env) {
    const u = updateTransactionInput.parse(raw);
    const current = await existing(env, u.transaction);
    const p = writable(env);
    const { patch, notes } = await resolveNames(
      p,
      {
        type: u.type ?? current.type,
        currency: u.currency,
        category: u.category,
        account: u.account,
        paymentMethod: u.paymentMethod,
        book: u.book,
        ...(u.books ? { books: u.books } : {}),
        toAccount: u.toAccount,
      },
      env,
      false,
    );
    const t = await p.updateTransaction(current.id, {
      ...patch,
      ...(u.type ? { type: u.type } : {}),
      ...(u.amount ? { amount: u.amount } : {}),
      ...(u.date ? { date: u.date } : {}),
      ...(u.description !== undefined
        ? { description: u.description ? normalizeEntityTitle(u.description) : null }
        : {}),
      ...(u.counterparty !== undefined ? { counterparty: u.counterparty } : {}),
      ...(u.subcategory !== undefined ? { subcategory: u.subcategory } : {}),
      ...(u.project !== undefined ? { project: u.project } : {}),
      ...(u.status ? { status: u.status } : {}),
      ...(u.notes !== undefined ? { notes: u.notes } : {}),
      ...(u.receipt !== undefined ? { receipt: u.receipt } : {}),
    });
    return showTransaction(t, "updated", notes);
  },
};

export const archiveTransactionTool: ToolDefinition = {
  name: "finance.archiveTransaction",
  capability: "finance",
  operation: "archiveTransaction",
  description: "Archive (remove from totals) a transaction. Needs the user's approval.",
  input: getInput,
  route: (input: z.infer<typeof getInput>) => routeRef(input.transaction),
  async describe(raw, env) {
    const t = await existing(env, getInput.parse(raw).transaction);
    return {
      summary: `Archive ${t.type} ${money(t.amount, t.currency, env.ctx.locale)} · ${t.counterparty ?? t.description ?? ""} (${t.date})`,
      target: { type: "finance_transaction", id: t.id },
    };
  },
  async run(raw, env) {
    const t = await existing(env, getInput.parse(raw).transaction);
    return showTransaction(await writable(env).archiveTransaction(t.id), "archived", []);
  },
};

const bulkInput = z
  .object({
    transactions: z.array(z.uuid()).min(1).max(500).describe("Transaction ids."),
    restore: z.boolean().optional().describe("true brings archived ones back (undo)."),
  })
  .strict();

/** Several movements at once (the list's selection): one statement, restorable. */
export const archiveTransactionsTool: ToolDefinition = {
  name: "finance.archiveTransactions",
  capability: "finance",
  operation: "archiveTransaction",
  description:
    "Archive (remove from totals) several transactions by id at once, or restore them. Needs the user's approval.",
  input: bulkInput,
  route: nativeOnly,
  async describe(raw, env) {
    const q = bulkInput.parse(raw);
    const n = q.transactions.length;
    return {
      summary:
        env.ctx.locale === "es"
          ? `${q.restore ? "Restaurar" : "Archivar"} ${n} movimiento${n === 1 ? "" : "s"}`
          : `${q.restore ? "Restore" : "Archive"} ${n} transaction${n === 1 ? "" : "s"}`,
    };
  },
  async run(raw, env) {
    const q = bulkInput.parse(raw);
    const p = writable(env);
    const changed = await nativeFeature(p.archiveTransactions?.bind(p))(
      q.transactions,
      q.restore ?? false,
    );
    return { output: { [q.restore ? "restored" : "archived"]: changed } };
  },
};

const undoInput = z.object({ importId: z.uuid() }).strict();

export const undoImportTool: ToolDefinition = {
  name: "finance.undoImport",
  capability: "finance",
  operation: "undoImport",
  description:
    "Undo one import: archives every transaction it created. Always needs the user's approval.",
  input: undoInput,
  route: nativeOnly,
  async describe(raw, env) {
    const info = await provider(env).describeImport(undoInput.parse(raw).importId);
    if (!info) throw new AppError("NOT_FOUND", "Import not found", { recovery: "review" });
    return {
      summary: `Archive the ${info.imported} transactions created by import “${info.label}”`,
      target: { type: "import", id: undoInput.parse(raw).importId },
    };
  },
  async run(raw, env) {
    const { importId } = undoInput.parse(raw);
    const result = await writable(env).undoImport(importId);
    return { output: result, target: { type: "import", id: importId } };
  },
};

export const createAccountTool: ToolDefinition = {
  name: "finance.createAccount",
  capability: "finance",
  operation: "createAccount",
  description:
    'Add an account or payment source ("Visa", "Cash USD", "PayPal", "Acme account"). Bookkeeping only; nothing connects to a bank.',
  input: createAccountInput,
  route: nativeOnly,
  async describe(raw) {
    return { summary: `Add account “${createAccountInput.parse(raw).name}”` };
  },
  async run(raw, env) {
    const a = createAccountInput.parse(raw);
    const account = await writable(env).createAccount(
      { name: a.name, type: a.type, currency: a.currency ?? null },
      sourceOf(env.ctx),
    );
    return {
      output: {
        created: true,
        account: { name: account.name, type: account.type, currency: account.currency },
      },
      display: { kind: "finance_accounts", accounts: [account] },
      target: { type: "finance_account", id: account.id },
    };
  },
};

export const updateAccountTool: ToolDefinition = {
  name: "finance.updateAccount",
  capability: "finance",
  operation: "updateAccount",
  description:
    'Rename an account, change its type or currency, archive it ("la Visa ahora es en USD"), or make it the default for movements recorded without an account (default). Past transactions keep it.',
  input: updateAccountInput,
  route: nativeOnly,
  async describe(raw) {
    return { summary: `Update account “${updateAccountInput.parse(raw).account}”` };
  },
  async run(raw, env) {
    const u = updateAccountInput.parse(raw);
    const p = writable(env);
    const account = pickOne(
      findByName(await p.listAccounts(), u.account, (a) => a.name),
      u.account,
      "account",
      (a) => a.name,
    );
    const updated = await p.updateAccount(account.id, {
      name: u.name,
      type: u.type,
      currency: u.currency,
      archived: u.archived,
    });
    if (u.book !== undefined) {
      const bookId = u.book === null ? null : (await resolveBook(p, u.book)).id;
      await nativeFeature(p.updateAccountBook?.bind(p))(account.id, bookId);
      updated.defaultBookId = bookId;
    }
    if (u.default !== undefined) {
      await nativeFeature(p.setDefaultAccount?.bind(p))(u.default ? account.id : null);
      updated.isDefault = u.default;
    }
    return {
      output: {
        updated: true,
        account: { name: updated.name, type: updated.type, currency: updated.currency },
        ...(u.archived ? { archived: true } : {}),
        ...(u.default !== undefined ? { default: u.default } : {}),
      },
      display: { kind: "finance_accounts", accounts: [updated] },
      target: { type: "finance_account", id: updated.id },
    };
  },
};

export const createCategoryTool: ToolDefinition = {
  name: "finance.createCategory",
  capability: "finance",
  operation: "createCategory",
  description: "Add a finance category, optionally under a parent category.",
  input: createCategoryInput,
  route: nativeOnly,
  async describe(raw) {
    return { summary: `Add category “${createCategoryInput.parse(raw).name}”` };
  },
  async run(raw, env) {
    const c = createCategoryInput.parse(raw);
    const p = writable(env);
    if (
      (c.type === "expense" || c.type === "income") &&
      duplicateCategory(await p.listCategories(), c.name, c.type)
    )
      throw new AppError(
        "CONFLICT",
        `A ${c.type} category “${cleanCategoryName(c.name)}” already exists`,
        {
          recovery: "review",
          details: { reason: "duplicate_name" },
        },
      );
    let parentId: string | null = null;
    if (c.parent) {
      const matches = findByName(await p.listCategories(), c.parent, (x) => x.name);
      parentId = pickOne(matches, c.parent, "category", (x) => x.name).id;
    }
    const category = await p.createCategory(
      { name: c.name, type: c.type, parentId, icon: c.icon ?? suggestCategoryIcon(c.name) },
      sourceOf(env.ctx),
    );
    return {
      output: {
        created: true,
        category: { name: category.name, type: category.type, parent: category.parent },
      },
      display: { kind: "finance_categories", categories: [category] },
      target: { type: "finance_category", id: category.id },
    };
  },
};

export const updateCategoryTool: ToolDefinition = {
  name: "finance.updateCategory",
  capability: "finance",
  operation: "updateCategory",
  description:
    "Rename a category, change its icon or parent, or archive it (its transactions keep it). To delete one, use finance.deleteCategory.",
  input: updateCategoryInput,
  route: nativeOnly,
  async describe(raw) {
    return { summary: `Update category “${updateCategoryInput.parse(raw).category}”` };
  },
  async run(raw, env) {
    const u = updateCategoryInput.parse(raw);
    const p = writable(env);
    const categories = await p.listCategories();
    const category = categoryRef(categories, u.category);
    const parentId =
      u.parent === undefined
        ? undefined
        : u.parent === null
          ? null
          : pickOne(
              findByName(categories, u.parent, (x) => x.name),
              u.parent,
              "category",
              (x) => x.name,
            ).id;
    const updated = await nativeFeature(p.updateCategory?.bind(p))(category.id, {
      ...(u.name !== undefined ? { name: u.name } : {}),
      ...(u.icon !== undefined ? { icon: u.icon } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(u.archived ? { archived: true } : {}),
    });
    return {
      output: { updated: true, category: { name: updated.name, icon: updated.icon ?? null } },
      display: { kind: "finance_categories", categories: [updated] },
      target: { type: "finance_category", id: updated.id },
    };
  },
};

const importFileInput = z
  .object({
    attachment: z.uuid().describe("The id of a CSV or .xlsx file attached in this conversation."),
  })
  .strict();

/**
 * ADR-075: a spreadsheet attached in chat goes through the Finance screen's own import pipeline,
 * reading the ORIGINAL stored file — never the preview the model saw. Nothing is written to
 * Finance here: the card lets the user pick the file's currency and start (or review) it.
 */
export const importFileTool: ToolDefinition = {
  name: "finance.importFile",
  capability: "finance",
  operation: "importFile",
  description:
    '"Importá esto a mis finanzas", "cargame estos movimientos", "pasá este Excel a Finanzas" with a CSV/.xlsx attached: analyzes the attached file (all of it, from the stored original) with the Finance importer and shows an import card. Use it instead of reading rows yourself; never ask to re-attach a file you have.',
  input: importFileInput,
  route: nativeOnly,
  async describe(raw, env) {
    return {
      summary:
        env.ctx.locale === "es"
          ? "Analizar el archivo para importar"
          : "Analyze the file to import",
      target: { type: "chat_attachment", id: importFileInput.parse(raw).attachment },
    };
  },
  async run(raw, env) {
    const { attachment } = importFileInput.parse(raw);
    const p = writable(env);
    const a = await nativeFeature(p.analyzeImportFile?.bind(p))(attachment);
    return {
      output: {
        rows: a.rows,
        format: a.format,
        dateRange: a.dateRange,
        ready: a.willImport,
        needsAttention: a.invalid,
        duplicates: a.duplicates,
        review: a.review,
        needs: a.needs,
        fileCurrency: a.fileCurrency ? (a.currency ?? "to choose") : null,
        typeStrategy: a.typeStrategy,
        instructions:
          "The import card is on screen with the choices and the buttons. In one or two short sentences say what was found (rows, and the source if recognized) and the one thing left, if any (e.g. the file's currency). Don't list columns or mappings, don't narrate uncertainty, and never say the file is truncated or ask to attach it again: the importer read the whole stored file. Nothing is imported until the user starts it.",
      },
      display: { kind: "finance_import", financeImport: a },
      target: { type: "import", id: a.importId },
    };
  },
};

/** A category by id (what the UI sends — names repeat across expense/income) or by name. */
function categoryRef(categories: FinanceCategory[], ref: string) {
  return (
    categories.find((c) => c.id === ref) ??
    pickOne(
      findByName(categories, ref, (x) => x.name),
      ref,
      "category",
      (x) => `${x.name} (${x.type})`,
    )
  );
}

export const deleteCategoryTool: ToolDefinition = {
  name: "finance.deleteCategory",
  capability: "finance",
  operation: "deleteCategory",
  description:
    "Delete a category. Its movements are kept and become uncategorized; never deletes a movement. Always needs the user's approval.",
  input: deleteCategoryInput,
  route: nativeOnly,
  async describe(raw, env) {
    const p = provider(env);
    const category = categoryRef(await p.listCategories(), deleteCategoryInput.parse(raw).category);
    const usage = await nativeFeature(p.categoryUsage?.bind(p))(category.id);
    return {
      summary: `Delete category “${category.name}”; ${usage.transactions} movements stay, uncategorized`,
      target: { type: "finance_category", id: category.id },
    };
  },
  async run(raw, env) {
    const { category: ref, preview } = deleteCategoryInput.parse(raw);
    const p = writable(env);
    const category = categoryRef(await p.listCategories(), ref);
    const usage = await nativeFeature(p.categoryUsage?.bind(p))(category.id);
    if (preview)
      return { output: { category: { id: category.id, name: category.name }, ...usage } };
    const done = await nativeFeature(p.deleteCategory?.bind(p))(category.id);
    return {
      output: {
        deleted: true,
        category: category.name,
        uncategorizedMovements: Math.max(done.uncategorized, usage.transactions),
        budgetsArchived: done.budgetsArchived,
        instructions: "Say the movements were kept, now without category.",
      },
      target: { type: "finance_category", id: category.id },
    };
  },
};

// ── ADR-052: Books, budgets, rates, reports, undo ────────────────────────────

function nativeFeature<T>(fn: T | undefined): T {
  if (!fn)
    throw new AppError("CAPABILITY_UNAVAILABLE", "Only ELISE Finance has this", {
      recovery: "review",
    });
  return fn;
}

const bookForModel = (b: FinanceBook) => ({
  name: b.name,
  type: b.type,
  ...(b.isDefault ? { default: true } : {}),
  ...(b.reportingCurrency ? { reportingCurrency: b.reportingCurrency } : {}),
});

export const listBooksTool: ToolDefinition = {
  name: "finance.listBooks",
  capability: "finance",
  operation: "listBooks",
  description:
    'The user\'s Ámbitos (Books): who money belongs to — "Personal", "Empresa"… Not categories. Use their names in `book`.',
  input: z.object({}).strict(),
  route: nativeOnly,
  async describe() {
    return { summary: "List Books" };
  },
  async run(_raw, env) {
    const books = await nativeFeature(provider(env).listBooks?.bind(provider(env)))();
    return {
      output: { books: books.map(bookForModel) },
      display: { kind: "finance_books", books },
    };
  },
};

export const saveBookTool: ToolDefinition = {
  name: "finance.saveBook",
  capability: "finance",
  operation: "saveBook",
  description:
    'Create or change an Ámbito ("creá un ámbito para mi empresa Acme" → name Acme, type business). Pass `book` to change an existing one.',
  input: saveBookInput,
  route: nativeOnly,
  async describe(raw) {
    const b = saveBookInput.parse(raw);
    return { summary: b.book ? `Update Book “${b.book}”` : `Create Book “${b.name ?? ""}”` };
  },
  async run(raw, env) {
    const b = saveBookInput.parse(raw);
    const p = writable(env);
    const existingBook = b.book ? await resolveBook(p, b.book) : null;
    if (!existingBook && !b.name)
      throw new AppError("VALIDATION_ERROR", "A new Book needs a name", { recovery: "review" });
    const saved = await nativeFeature(p.saveBook?.bind(p))({
      ...(existingBook ? { id: existingBook.id } : {}),
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.type !== undefined ? { type: b.type } : {}),
      ...(b.icon !== undefined ? { icon: b.icon } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.reportingCurrency !== undefined ? { reportingCurrency: b.reportingCurrency } : {}),
      ...(b.isDefault !== undefined ? { isDefault: b.isDefault } : {}),
      ...(b.archived !== undefined ? { archived: b.archived } : {}),
    });
    return {
      output: { saved: bookForModel(saved) },
      display: { kind: "finance_books", books: [saved] },
      target: { type: "finance_book", id: saved.id },
    };
  },
};

export const budgetsTool: ToolDefinition = {
  name: "finance.getBudgets",
  capability: "finance",
  operation: "getBudgets",
  description:
    '"¿Cómo voy con publicidad?", "¿qué presupuestos estoy por pasar?": monthly budgets with spent, remaining and percent — computed by ELISE (80% = close, 100% = over).',
  input: budgetsInput,
  route: nativeOnly,
  async describe() {
    return { summary: "Budgets" };
  },
  async run(raw, env) {
    const input = budgetsInput.parse(raw);
    const p = provider(env);
    const month = input.month ?? today(env).slice(0, 7);
    const from = `${month}-01`;
    const to = resolvePeriod("this_month", from).to;
    const bookId = input.book ? (await resolveBook(p, input.book)).id : null;
    const [budgets, page] = await Promise.all([
      nativeFeature(p.listBudgets?.bind(p))(),
      p.transactions({ from, to, type: "expense" }, MAX_ROWS),
    ]);
    const usages = budgets
      .filter((b) => !bookId || b.bookId === bookId)
      .map((b) => budgetUsage(b, page.rows))
      .filter((u) => !input.onlyAtRisk || u.state !== "ok")
      .sort((a, b) => b.percentTenths - a.percentTenths);
    return {
      output: {
        month,
        budgets: usages.map((u) => ({
          category: u.category,
          ...(u.subcategory ? { subcategory: u.subcategory } : {}),
          ...(u.book ? { book: u.book } : {}),
          currency: u.currency,
          budget: u.amount,
          spent: u.spent,
          remaining: u.remaining,
          percent: u.percentTenths / 10,
          state: u.state,
          ...(u.otherCurrencies ? { otherCurrencyExpensesNotCounted: u.otherCurrencies } : {}),
          ...(u.pending ? { pendingNotCounted: u.pending } : {}),
        })),
      },
      display: { kind: "finance_budgets", month, budgets: usages },
    };
  },
};

export const setBudgetTool: ToolDefinition = {
  name: "finance.setBudget",
  capability: "finance",
  operation: "setBudget",
  description:
    '"Poneme un presupuesto de 200 lucas por mes en restaurantes", "presupuesto de 200 mil entre restaurantes, bares y entretenimiento" (ONE budget over several categories: use `categories`), "subí herramientas a 180 mil": a monthly spending guide per Book (creates or updates it). archived removes it.',
  input: setBudgetInput,
  route: nativeOnly,
  async describe(raw) {
    const b = setBudgetInput.parse(raw);
    const what = b.name ?? (b.categories ?? [b.category ?? "—"]).join(", ");
    return { summary: `Budget ${what}: ${b.amount}${b.currency ? ` ${b.currency}` : ""}` };
  },
  async run(raw, env) {
    const b = setBudgetInput.parse(raw);
    const p = writable(env);
    const refs = [...new Set([...(b.categories ?? []), ...(b.category ? [b.category] : [])])];
    if (!refs.length && !b.id)
      throw new AppError("VALIDATION_ERROR", "Which categories should the budget cover?", {
        recovery: "review",
      });
    if (b.subcategory && refs.length > 1)
      throw new AppError("VALIDATION_ERROR", "A subcategory only fits a single-category budget", {
        recovery: "review",
      });
    if (b.icon && !isSingleEmoji(b.icon))
      throw new AppError("VALIDATION_ERROR", "The icon must be a single emoji", {
        recovery: "review",
      });
    const categories = await p.listCategories();
    // Spending budgets: expense categories only (deterministic resolution, never a guess).
    const picked = refs.map((ref) =>
      pickOne(resolveCategory(categories, ref, "expense"), ref, "category", (c) => c.name),
    );
    const existing = b.id ? (await p.listBudgets?.())?.find((x) => x.id === b.id) : undefined;
    if (b.id && !existing) throw new AppError("NOT_FOUND", "Budget not found");
    const books = (await p.listBooks?.()) ?? [];
    const bookId = b.book
      ? (await resolveBook(p, b.book)).id
      : (existing?.bookId ?? books.find((x) => x.isDefault)?.id ?? null);
    const currency = await currencyFor(p, b.currency, null);
    const saved = await nativeFeature(p.saveBudget?.bind(p))({
      ...(b.id ? { id: b.id } : {}),
      name: b.name ?? existing?.name ?? null,
      icon: b.icon ?? existing?.icon ?? null,
      bookId,
      categoryIds: picked.length ? picked.map((c) => c.id) : (existing?.categoryIds ?? []),
      subcategory: b.subcategory ?? null,
      currency,
      amount: b.amount,
      ...(b.archived ? { archived: true } : {}),
    });
    const month = today(env).slice(0, 7);
    const page = await p.transactions(
      { from: `${month}-01`, to: resolvePeriod("this_month", `${month}-01`).to, type: "expense" },
      MAX_ROWS,
    );
    const usage = budgetUsage(saved, page.rows);
    return {
      output: {
        [b.archived ? "removed" : "saved"]: {
          category: saved.category,
          categories: saved.categories,
          book: saved.book,
          currency,
          amount: saved.amount,
          spentThisMonth: usage.spent,
          percent: usage.percentTenths / 10,
        },
      },
      display: { kind: "finance_budgets", month, budgets: b.archived ? [] : [usage] },
      target: { type: "finance_budget", id: saved.id },
    };
  },
};

const combineInput = z
  .object({
    transactions: z.array(z.uuid()).min(2).max(500),
    description: z.string().trim().max(300).nullable().optional(),
    /** null = "Sin categoría". Omitted = same category kept when they all share it. */
    category: z.uuid().nullable().optional(),
  })
  .strict();

/**
 * ADR-083: several movements of one account and one currency become one, by signed sum. The
 * sources stay (hidden, linked, recoverable): never a silent deletion. Runs when asked (undo exists).
 */
export const combineTransactionsTool: ToolDefinition = {
  name: "finance.combineTransactions",
  capability: "finance",
  operation: "combineTransactions",
  description:
    "Combine 2+ movements of the SAME account (or all without one) and currency into one (signed sum). Only when the user asks for it; then just do it (reversible with finance.uncombineTransaction).",
  input: combineInput,
  route: nativeOnly,
  async describe(raw) {
    const c = combineInput.parse(raw);
    return { summary: `Combine ${c.transactions.length} movements into one` };
  },
  async run(raw, env) {
    const c = combineInput.parse(raw);
    const p = writable(env);
    const rows = await Promise.all(c.transactions.map((id) => p.getTransaction(id)));
    if (rows.some((r) => !r)) throw new AppError("NOT_FOUND", "Movements not found");
    const plan = planCombine(rows as FinanceTransaction[]);
    if (!plan.ok)
      throw new AppError("VALIDATION_ERROR", `These movements can't be combined (${plan.reason})`, {
        recovery: "review",
        details: { reason: plan.reason },
      });
    const id = await nativeFeature(p.combineTransactions?.bind(p))(c.transactions, {
      description: c.description?.trim() || plan.description,
      categoryId: c.category === undefined ? plan.categoryId : c.category,
    });
    return {
      output: {
        combined: c.transactions.length,
        transaction: {
          id,
          type: plan.type,
          amount: plan.amount,
          currency: plan.currency,
          date: plan.date,
        },
      },
      target: { type: "finance_transaction", id },
    };
  },
};

export const uncombineTransactionTool: ToolDefinition = {
  name: "finance.uncombineTransaction",
  capability: "finance",
  operation: "combineTransactions",
  description: "Undo a combination: its original movements come back exactly as they were.",
  input: z.object({ transaction: z.uuid() }).strict(),
  route: nativeOnly,
  async describe() {
    return { summary: "Undo a combined movement" };
  },
  async run(raw, env) {
    const { transaction } = z.object({ transaction: z.uuid() }).strict().parse(raw);
    const restored = await nativeFeature(writable(env).uncombineTransaction?.bind(writable(env)))(
      transaction,
    );
    return { output: { restored }, target: { type: "finance_transaction", id: transaction } };
  },
};

export const setRateTool: ToolDefinition = {
  name: "finance.setRate",
  capability: "finance",
  operation: "setRate",
  description:
    'Save an exchange rate the user gives ("el dólar está a 1450") for reports in one currency. Dated: past records keep the rate of their own date.',
  input: setRateInput,
  route: nativeOnly,
  async describe(raw) {
    const r = setRateInput.parse(raw);
    return { summary: `1 ${r.from} = ${r.rate} ${r.to}` };
  },
  async run(raw, env) {
    const r = setRateInput.parse(raw);
    const p = writable(env);
    const saved = await nativeFeature(p.saveRate?.bind(p))({
      from: r.from,
      to: r.to,
      rate: r.rate,
      date: r.date ?? today(env),
    });
    return { output: { saved } };
  },
};

export const reportTool: ToolDefinition = {
  name: "finance.createReport",
  capability: "finance",
  operation: "createReport",
  description:
    '"Preparame un reporte de gastos de la empresa de septiembre", "un PDF sin listar cada transacción": prepares the financial report (same filters as everything else) and returns its preview and PDF links. Numbers come from ELISE, never from you.',
  input: reportInput,
  route: nativeOnly,
  async describe() {
    return { summary: "Financial report" };
  },
  async run(raw, env) {
    const input = reportInput.parse(raw);
    const p = provider(env);
    const period = periodOf(input, today(env));
    const filter = { ...filterOf(input, period), ...period };
    const [page, budgets, rates, sources] = await Promise.all([
      p.transactions({ ...filter, statuses: undefined }, MAX_ROWS),
      p.listBudgets?.() ?? Promise.resolve([]),
      input.reportingCurrency ? (p.listRates?.() ?? Promise.resolve([])) : Promise.resolve([]),
      p.sources(),
    ]);
    const report = buildFinanceReport({
      rows: page.rows,
      filter,
      sections: input.sections ?? DEFAULT_REPORT_SECTIONS,
      book: input.book ?? null,
      budgets,
      rates,
      reportingCurrency: input.reportingCurrency ?? null,
      sources: relevantSources(sources, filter.source),
      truncated: page.truncated,
    });
    const query = reportQuery(input, period);
    return {
      output: {
        period,
        ...(input.book ? { book: input.book } : {}),
        totals: report.totals,
        ...(report.converted ? { converted: report.converted } : {}),
        transactions: report.transactions.length,
        sections: report.sections,
        previewUrl: `/my-elise/finance/reports?${query}`,
        pdfUrl: `/api/finance/report?${query}`,
        note: "Point the user to the PDF link; the numbers above are exactly what it contains.",
      },
      display: {
        kind: "finance_report",
        report,
        previewUrl: `/my-elise/finance/reports?${query}`,
        pdfUrl: `/api/finance/report?${query}`,
      },
    };
  },
};

/** The report's filters as a URL query (same definition for preview, PDF and chat). */
export function reportQuery(
  input: ReturnType<typeof reportInput.parse>,
  period: { from: string; to: string },
): string {
  const q = new URLSearchParams({ from: period.from, to: period.to });
  const add = (k: string, v: string | undefined) => v && q.set(k, v);
  add("book", input.book);
  add("type", input.type);
  add("category", input.category);
  add("subcategory", input.subcategory);
  add("account", input.account);
  add("counterparty", input.counterparty);
  add("project", input.project);
  add("currency", input.currency?.join(","));
  add("status", input.status?.join(","));
  add("rc", input.reportingCurrency);
  if (input.sections) q.set("sections", input.sections.join(","));
  return q.toString();
}

const restoreInput = z.object({ transaction: transactionRef }).strict();

export const restoreTransactionTool: ToolDefinition = {
  name: "finance.restoreTransaction",
  capability: "finance",
  operation: "restoreTransaction",
  description: "Undo deleting a transaction (brings it back exactly as it was).",
  input: restoreInput,
  route: nativeOnly,
  async describe() {
    return { summary: "Restore transaction" };
  },
  async run(raw, env) {
    const p = writable(env) as FinanceProvider & {
      restoreTransaction?: (id: string) => Promise<FinanceTransaction>;
    };
    const t = await nativeFeature(p.restoreTransaction?.bind(p))(
      restoreInput.parse(raw).transaction,
    );
    return showTransaction(t, "updated", ["Restored."]);
  },
};

export { UNCLASSIFIED };

export const FINANCE_TOOLS = [
  updateCategoryTool,
  deleteCategoryTool,
  combineTransactionsTool,
  uncombineTransactionTool,
  importFileTool,
  getSummaryTool,
  queryTool,
  listTransactionsTool,
  getTransactionTool,
  listAccountsTool,
  listCategoriesTool,
  createTransactionTool,
  updateTransactionTool,
  archiveTransactionTool,
  archiveTransactionsTool,
  undoImportTool,
  createAccountTool,
  updateAccountTool,
  createCategoryTool,
  listBooksTool,
  saveBookTool,
  budgetsTool,
  setBudgetTool,
  setRateTool,
  reportTool,
  restoreTransactionTool,
];
