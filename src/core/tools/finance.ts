import { z } from "zod";

import { pickOne, sourceOf } from "./native-common";
import type { ToolDefinition, ToolRunEnv, ToolRunResult } from "../agents/tools";
import {
  comparisonPeriod,
  computeBreakdown,
  computeTotals,
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
import { AppError } from "../errors";
import { formatMoney } from "../finance/money";
import { parseExternalRef } from "../providers/refs";
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
    const [current, previous, sources] = await Promise.all([
      p.transactions(fetchFilter, MAX_ROWS),
      comparison
        ? p.transactions({ ...fetchFilter, from: comparison.from, to: comparison.to }, MAX_ROWS)
        : null,
      p.sources(),
    ]);
    return showSummary(
      finalizeSummary({
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
    );
  },
  merge(results) {
    return showSummary(
      mergeSummaries(results.map((r) => (r.result.display as { summary: FinanceSummary }).summary)),
    );
  },
};

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
    '"¿Cuánto gasté en software en septiembre?", "gastos por categoría", "ingresos de Firbot por mes", "USD vs ARS": deterministic filtered totals, optionally grouped (category, month, account, counterparty, project, source, currency…). Totals are per currency.',
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
  const compatible = categories.filter((c) => c.type === type || c.type === "both");
  return findByName(compatible, name, (c) => c.name);
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
  },
  env: ToolRunEnv,
  needCurrency: boolean,
): Promise<Resolved> {
  const notes: string[] = [];
  const patch: TransactionPatch = {};
  let account: FinanceAccount | null = null;
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
        { name: input.category, type: input.type, parentId: null },
        sourceOf(env.ctx),
      );
      patch.categoryId = created.id;
      notes.push(`Created category "${created.name}".`);
    }
  } else if (input.category === null) patch.categoryId = null;

  if (needCurrency || input.currency)
    patch.currency = await currencyFor(p, input.currency, account);
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
    'Record an expense or income: "Gasté 25 dólares en OpenAI" → expense, 25, USD, counterparty OpenAI, category Software (categoryInferred). Omit currency if the user did not give it; ELISE uses the account or default currency, or tells you to ask. Amount uses "." for decimals ("$48.000" → "48000").',
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
    const { patch, notes } = await resolveNames(p, c, env, true);
    const t = await p.createTransaction(
      {
        type: c.type,
        amount: c.amount,
        currency: patch.currency!,
        date: c.date ?? today(env),
        description: c.description ?? null,
        counterparty: c.counterparty ?? null,
        categoryId: patch.categoryId ?? null,
        subcategory: c.subcategory ?? null,
        accountId: patch.accountId ?? null,
        paymentMethod: patch.paymentMethod ?? c.paymentMethod ?? null,
        project: c.project ?? null,
        status: c.status ?? "completed",
        notes: c.notes ?? null,
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
      },
      env,
      false,
    );
    const t = await p.updateTransaction(current.id, {
      ...patch,
      ...(u.type ? { type: u.type } : {}),
      ...(u.amount ? { amount: u.amount } : {}),
      ...(u.date ? { date: u.date } : {}),
      ...(u.description !== undefined ? { description: u.description } : {}),
      ...(u.counterparty !== undefined ? { counterparty: u.counterparty } : {}),
      ...(u.subcategory !== undefined ? { subcategory: u.subcategory } : {}),
      ...(u.project !== undefined ? { project: u.project } : {}),
      ...(u.status ? { status: u.status } : {}),
      ...(u.notes !== undefined ? { notes: u.notes } : {}),
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
    'Add an account or payment source ("Visa", "Cash USD", "PayPal", "Firbot account"). Bookkeeping only; nothing connects to a bank.',
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
    'Rename an account, change its type or currency, or archive it ("la Visa ahora es en USD"). Past transactions keep it.',
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
    return {
      output: {
        updated: true,
        account: { name: updated.name, type: updated.type, currency: updated.currency },
        ...(u.archived ? { archived: true } : {}),
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
    let parentId: string | null = null;
    if (c.parent) {
      const matches = findByName(await p.listCategories(), c.parent, (x) => x.name);
      parentId = pickOne(matches, c.parent, "category", (x) => x.name).id;
    }
    const category = await p.createCategory(
      { name: c.name, type: c.type, parentId },
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

export const FINANCE_TOOLS = [
  getSummaryTool,
  queryTool,
  listTransactionsTool,
  getTransactionTool,
  listAccountsTool,
  listCategoriesTool,
  createTransactionTool,
  updateTransactionTool,
  archiveTransactionTool,
  undoImportTool,
  createAccountTool,
  updateAccountTool,
  createCategoryTool,
];
