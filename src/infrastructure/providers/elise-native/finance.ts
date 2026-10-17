import {
  fingerprint,
  NATIVE_SOURCE_NAME,
  norm,
  STARTER_CATEGORIES,
  UNCLASSIFIED,
  type AccountType,
  type Budget,
  type CategoryType,
  type FinanceAccount,
  type FinanceBook,
  type FinanceCategory,
  type FinanceProvider,
  type FinanceTransaction,
  type FxRate,
  type NewTransaction,
  type TransactionFilter,
  type TransactionOrigin,
  type TransactionPatch,
} from "@/core/capabilities/finance";
import type { EntrySource } from "@/core/capabilities/habits";
import { isSingleEmoji } from "@/core/emoji";
import { AppError } from "@/core/errors";
import { normalizeAmount } from "@/core/finance/money";
import type {
  FinanceAccountRow,
  FinanceBookRow,
  FinanceCategoryRow,
  FinanceTransactionRow,
} from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import { check, escapeLike, needsUpdate, notMigrated } from "./common";

/** numeric is read as text so no amount ever passes through a float. */
const V1_COLUMNS =
  "id, transaction_type, amount::text, currency, transaction_date, description, counterparty, account_id, category_id, subcategory, payment_method, project, status, notes, import_id, import_row_number, fingerprint, updated_at, source";
/** ADR-052 (migration 039): Book, transfer destination and receipt. */
export const TRANSACTION_COLUMNS = `${V1_COLUMNS}, book_id, to_account_id, receipt`;

type TxRow = Pick<
  FinanceTransactionRow,
  | "id"
  | "transaction_type"
  | "amount"
  | "currency"
  | "transaction_date"
  | "description"
  | "counterparty"
  | "account_id"
  | "category_id"
  | "subcategory"
  | "payment_method"
  | "project"
  | "status"
  | "notes"
  | "import_id"
  | "import_row_number"
  | "fingerprint"
  | "updated_at"
  | "source"
  | "book_id"
  | "to_account_id"
  | "receipt"
>;

const PAGE = 1000;
const UUID = /^[0-9a-f-]{36}$/i;

const ORIGIN: Record<string, TransactionOrigin> = {
  user_ui: "manual",
  ai: "chat",
  import: "import",
  schedule: "system",
  system: "system",
};

const toAccount = (r: FinanceAccountRow): FinanceAccount => ({
  id: r.id,
  name: r.name,
  type: r.account_type,
  currency: r.currency,
  defaultBookId: r.default_book_id ?? null,
});

const toBook = (r: FinanceBookRow): FinanceBook => ({
  id: r.id,
  name: r.name,
  type: r.book_type,
  icon: r.icon,
  description: r.description,
  reportingCurrency: r.reporting_currency,
  isDefault: r.is_default,
});

interface Catalog {
  accounts: FinanceAccountRow[];
  categories: FinanceCategoryRow[];
  books: FinanceBookRow[];
  /** False until migration 039 is applied (Books, transfers, receipts are unavailable). */
  v2: boolean;
}

/** ELISE Finance (Native provider): the workspace's own ledger. */
export class EliseFinanceProvider implements FinanceProvider {
  readonly readOnly = false;
  private catalog?: Promise<Catalog>;

  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
    private readonly connectionId: string,
    private readonly locale: "es" | "en",
  ) {}

  private load() {
    this.catalog ??= (async () => {
      const [accounts, categories, books] = await Promise.all([
        this.db.from("finance_accounts").select("*").eq("workspace_id", this.workspaceId),
        this.db.from("finance_categories").select("*").eq("workspace_id", this.workspaceId),
        this.db
          .from("finance_books")
          .select("*")
          .eq("workspace_id", this.workspaceId)
          .is("archived_at", null)
          .order("created_at"),
      ]);
      check(accounts.error, "load accounts");
      check(categories.error, "load categories");
      const v2 = !books.error;
      if (books.error && !notMigrated(books.error.code)) check(books.error, "load books");
      return {
        accounts: accounts.data ?? [],
        categories: categories.data ?? [],
        books: books.data ?? [],
        v2,
      };
    })();
    return this.catalog;
  }

  private invalidate() {
    this.catalog = undefined;
  }

  private columns(c: Catalog) {
    return c.v2 ? TRANSACTION_COLUMNS : V1_COLUMNS;
  }

  private shape(r: TxRow, catalog: Catalog): FinanceTransaction {
    const byId = new Map(catalog.categories.map((c) => [c.id, c]));
    const path: string[] = [];
    let cursor = r.category_id ? byId.get(r.category_id) : undefined;
    for (let depth = 0; cursor && depth < 8; depth++) {
      path.unshift(cursor.name);
      cursor = cursor.parent_category_id ? byId.get(cursor.parent_category_id) : undefined;
    }
    const account = catalog.accounts.find((a) => a.id === r.account_id);
    const to = r.to_account_id ? catalog.accounts.find((a) => a.id === r.to_account_id) : null;
    const book = r.book_id ? catalog.books.find((b) => b.id === r.book_id) : null;
    return {
      id: r.id,
      type: r.transaction_type,
      amount: normalizeAmount(String(r.amount)),
      currency: r.currency,
      date: r.transaction_date,
      description: r.description,
      counterparty: r.counterparty,
      category: path.at(-1) ?? null,
      categoryId: r.category_id,
      categoryPath: path,
      subcategory: r.subcategory,
      account: account?.name ?? null,
      accountId: r.account_id,
      paymentMethod: r.payment_method,
      project: r.project,
      status: r.status,
      notes: r.notes,
      importId: r.import_id,
      bookId: r.book_id ?? null,
      book: book?.name ?? null,
      toAccountId: r.to_account_id ?? null,
      toAccount: to?.name ?? null,
      receipt: r.receipt ?? null,
      origin: r.import_id ? "import" : (ORIGIN[r.source] ?? "manual"),
      readOnly: false,
      fingerprint: r.fingerprint,
      provenance: {
        providerKey: "elise_native",
        connectionId: this.connectionId,
        source: NATIVE_SOURCE_NAME,
        sourceId: null,
        row: r.import_row_number,
      },
      updatedAt: r.updated_at,
    };
  }

  async sources() {
    return [
      {
        key: "native",
        name: NATIVE_SOURCE_NAME,
        kind: "native" as const,
        lastSyncedAt: null,
        included: true,
      },
    ];
  }

  /** A Book filter by id (or "unclassified") narrows in the database; names match in Core. */
  private bookColumn(filter: TransactionFilter, catalog: Catalog): string | null | undefined {
    if (!filter.book || !catalog.v2) return undefined;
    if (filter.book === UNCLASSIFIED) return null;
    if (UUID.test(filter.book)) return filter.book;
    const named = catalog.books.filter((b) => norm(b.name) === norm(filter.book!));
    return named.length === 1 ? named[0]!.id : undefined;
  }

  async transactions(filter: TransactionFilter, max: number) {
    if (filter.source && !norm(NATIVE_SOURCE_NAME).includes(norm(filter.source))) {
      if (!norm(filter.source).includes("elise")) return { rows: [], truncated: false };
    }
    const catalog = await this.load();
    const book = this.bookColumn(filter, catalog);
    const rows: TxRow[] = [];
    for (let offset = 0; offset < max; offset += PAGE) {
      let q = this.db
        .from("finance_transactions")
        .select(this.columns(catalog))
        .eq("workspace_id", this.workspaceId)
        .is("archived_at", null);
      if (filter.from) q = q.gte("transaction_date", filter.from);
      if (filter.to) q = q.lte("transaction_date", filter.to);
      if (filter.type) q = q.eq("transaction_type", filter.type);
      if (filter.currencies?.length) q = q.in("currency", filter.currencies);
      if (book === null) q = q.is("book_id", null);
      else if (book) q = q.eq("book_id", book);
      const { data, error } = await q
        .order("transaction_date", { ascending: false })
        .order("created_at", { ascending: false })
        .range(offset, Math.min(offset + PAGE, max) - 1);
      check(error, "load transactions");
      rows.push(...((data ?? []) as unknown as TxRow[]));
      if ((data ?? []).length < PAGE)
        return { rows: rows.map((r) => this.shape(r, catalog)), truncated: false };
    }
    return { rows: rows.map((r) => this.shape(r, catalog)), truncated: true };
  }

  async getTransaction(id: string) {
    if (!UUID.test(id)) return null;
    const catalog = await this.load();
    const { data } = await this.db
      .from("finance_transactions")
      .select(this.columns(catalog))
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    return data ? this.shape(data as unknown as TxRow, catalog) : null;
  }

  /**
   * The spelling already used for this name ("open ai" → "OpenAI"), so analytics don't split
   * one counterparty or project into several. ponytail: exact case-insensitive match on the
   * most recent use; aliases ("OPENAI *CHATGPT") come from import learning, not here.
   */
  private async canonical(column: "counterparty" | "project", value: string | null | undefined) {
    if (!value?.trim()) return value ?? null;
    const { data } = await this.db
      .from("finance_transactions")
      .select(column)
      .eq("workspace_id", this.workspaceId)
      .ilike(column, escapeLike(value.trim()))
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const found = (data as Record<string, string | null> | null)?.[column];
    return found ?? value.trim();
  }

  async createTransaction(t: NewTransaction, source: EntrySource) {
    const catalog = await this.load();
    const [counterparty, project] = await Promise.all([
      this.canonical("counterparty", t.counterparty),
      this.canonical("project", t.project),
    ]);
    if (!catalog.v2 && (t.type === "transfer" || t.toAccountId)) throw needsUpdate();
    const row = {
      workspace_id: this.workspaceId,
      transaction_type: t.type,
      amount: normalizeAmount(t.amount),
      currency: t.currency,
      transaction_date: t.date,
      description: t.description ?? null,
      counterparty,
      account_id: t.accountId ?? null,
      category_id: t.categoryId ?? null,
      subcategory: t.subcategory ?? null,
      payment_method: t.paymentMethod ?? null,
      project,
      status: t.status ?? "completed",
      notes: t.notes ?? null,
      source,
      import_id: t.importId ?? null,
      import_row_number: t.importRow ?? null,
      external_reference: t.externalReference ?? null,
      fingerprint: fingerprint({ ...t, counterparty }),
      created_by_user_id: this.userId,
      ...(catalog.v2
        ? {
            book_id: t.bookId ?? null,
            to_account_id: t.toAccountId ?? null,
            receipt: t.receipt ?? null,
          }
        : {}),
    };
    const { data, error } = await this.db
      .from("finance_transactions")
      .insert(row)
      .select(this.columns(catalog))
      .single();
    check(error, "record the transaction");
    return this.shape(data as unknown as TxRow, catalog);
  }

  async updateTransaction(id: string, p: TransactionPatch) {
    const current = await this.getTransaction(id);
    if (!current) throw new AppError("NOT_FOUND", "Transaction not found");
    const catalog = await this.load();
    const counterparty =
      p.counterparty !== undefined
        ? await this.canonical("counterparty", p.counterparty)
        : undefined;
    const project =
      p.project !== undefined ? await this.canonical("project", p.project) : undefined;
    const next = {
      type: p.type ?? current.type,
      amount: p.amount ?? current.amount,
      currency: p.currency ?? current.currency,
      date: p.date ?? current.date,
      counterparty: counterparty !== undefined ? counterparty : current.counterparty,
      description: p.description !== undefined ? p.description : current.description,
    };
    const v2Fields =
      p.bookId !== undefined || p.toAccountId !== undefined || p.receipt !== undefined;
    if ((v2Fields || p.type === "transfer") && !catalog.v2) throw needsUpdate();
    const set = <K extends string, V>(key: K, value: V | undefined) =>
      value !== undefined ? { [key]: value } : {};
    const { data, error } = await this.db
      .from("finance_transactions")
      .update({
        ...set("transaction_type", p.type),
        ...set("amount", p.amount ? normalizeAmount(p.amount) : undefined),
        ...set("currency", p.currency),
        ...set("transaction_date", p.date),
        ...set("description", p.description),
        ...set("counterparty", counterparty),
        ...set("account_id", p.accountId),
        ...set("category_id", p.categoryId),
        ...set("subcategory", p.subcategory),
        ...set("payment_method", p.paymentMethod),
        ...set("project", project),
        ...set("status", p.status),
        ...set("notes", p.notes),
        ...set("book_id", p.bookId),
        ...set("to_account_id", p.toAccountId),
        ...set("receipt", p.receipt),
        fingerprint: fingerprint(next),
      })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .select(this.columns(catalog))
      .single();
    check(error, "update the transaction");
    return this.shape(data as unknown as TxRow, catalog);
  }

  async archiveTransaction(id: string) {
    const current = await this.getTransaction(id);
    if (!current) throw new AppError("NOT_FOUND", "Transaction not found");
    const { error } = await this.db
      .from("finance_transactions")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    check(error, "archive the transaction");
    return current;
  }

  /** Undo of an archive (the record comes back exactly as it was). */
  async restoreTransaction(id: string) {
    if (!UUID.test(id)) throw new AppError("NOT_FOUND", "Transaction not found");
    const { error } = await this.db
      .from("finance_transactions")
      .update({ archived_at: null })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    check(error, "restore the transaction");
    const t = await this.getTransaction(id);
    if (!t) throw new AppError("NOT_FOUND", "Transaction not found");
    return t;
  }

  async listAccounts() {
    const { accounts } = await this.load();
    return accounts
      .filter((a) => !a.archived_at)
      .map(toAccount)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createAccount(
    a: { name: string; type: AccountType; currency: string | null },
    source: EntrySource,
  ) {
    const existing = (await this.listAccounts()).find((x) => norm(x.name) === norm(a.name));
    if (existing) return existing;
    const { data, error } = await this.db
      .from("finance_accounts")
      .insert({
        workspace_id: this.workspaceId,
        name: a.name,
        account_type: a.type,
        currency: a.currency,
        source,
        created_by_user_id: this.userId,
      })
      .select("*")
      .single();
    check(error, "add the account");
    this.invalidate();
    return toAccount(data!);
  }

  async updateAccount(
    id: string,
    p: { name?: string; type?: AccountType; currency?: string | null; archived?: boolean },
  ) {
    const { data, error } = await this.db
      .from("finance_accounts")
      .update({
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.type !== undefined ? { account_type: p.type } : {}),
        ...(p.currency !== undefined ? { currency: p.currency } : {}),
        ...(p.archived !== undefined
          ? p.archived
            ? { status: "archived" as const, archived_at: new Date().toISOString() }
            : { status: "active" as const, archived_at: null }
          : {}),
      })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .select("*")
      .maybeSingle();
    check(error, "update the account");
    if (!data) throw new AppError("NOT_FOUND", "Account not found");
    this.invalidate();
    return toAccount(data);
  }

  async updateAccountBook(accountId: string, bookId: string | null) {
    const { v2 } = await this.load();
    if (!v2) throw needsUpdate();
    const { error } = await this.db
      .from("finance_accounts")
      .update({ default_book_id: bookId })
      .eq("id", accountId)
      .eq("workspace_id", this.workspaceId);
    check(error, "set the account's Book");
    this.invalidate();
  }

  /** New workspaces start with a small, editable set of categories in the user's language. */
  private async ensureStarterCategories() {
    const { categories } = await this.load();
    if (categories.length) return;
    const { error } = await this.db.from("finance_categories").insert(
      STARTER_CATEGORIES[this.locale].map((c) => ({
        workspace_id: this.workspaceId,
        name: c.name,
        category_type: c.type,
        source: "system" as const,
      })),
    );
    // A concurrent first visit may have seeded them already.
    if (error && error.code !== "23505") check(error, "prepare categories");
    this.invalidate();
  }

  async listCategories(): Promise<FinanceCategory[]> {
    await this.ensureStarterCategories();
    const { categories } = await this.load();
    const active = categories.filter((c) => !c.archived_at);
    return active
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.category_type,
        parentId: c.parent_category_id,
        parent: active.find((p) => p.id === c.parent_category_id)?.name ?? null,
        bookIds: c.book_ids ?? [],
        icon: c.icon && isSingleEmoji(c.icon) ? c.icon : null,
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  async createCategory(
    c: {
      name: string;
      type: CategoryType;
      parentId: string | null;
      bookIds?: string[];
      icon?: string | null;
    },
    source: EntrySource,
  ) {
    const existing = (await this.listCategories()).find(
      (x) => norm(x.name) === norm(c.name) && x.type === c.type,
    );
    if (existing) return existing;
    const { v2 } = await this.load();
    const { data, error } = await this.db
      .from("finance_categories")
      .insert({
        workspace_id: this.workspaceId,
        name: c.name,
        category_type: c.type,
        parent_category_id: c.parentId,
        source,
        ...(v2 && c.bookIds?.length ? { book_ids: c.bookIds } : {}),
        ...((await this.categoryIcons()) && c.icon ? { icon: c.icon } : {}),
      })
      .select("*")
      .single();
    check(error, "add the category");
    this.invalidate();
    const categories = await this.listCategories();
    return categories.find((x) => x.id === data!.id)!;
  }

  /** Category icons exist from migration 041 on (ADR-054). */
  private async categoryIcons(): Promise<boolean> {
    const { error } = await this.db.from("finance_categories").select("icon").limit(1);
    return !error;
  }

  async updateCategory(
    id: string,
    p: { name?: string; icon?: string | null; parentId?: string | null; archived?: boolean },
  ) {
    if (p.icon !== undefined && !(await this.categoryIcons())) throw needsUpdate();
    const { data, error } = await this.db
      .from("finance_categories")
      .update({
        ...(p.name !== undefined ? { name: p.name } : {}),
        ...(p.icon !== undefined ? { icon: p.icon } : {}),
        ...(p.parentId !== undefined ? { parent_category_id: p.parentId } : {}),
        ...(p.archived
          ? { archived_at: new Date().toISOString(), status: "archived" as const }
          : {}),
      })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .select("id")
      .maybeSingle();
    if (error?.code === "23505")
      throw new AppError("CONFLICT", "A category with that name already exists", {
        recovery: "review",
        details: { reason: "duplicate_name" },
      });
    check(error, "update the category");
    if (!data) throw new AppError("NOT_FOUND", "Category not found");
    this.invalidate();
    const all = (await this.load()).categories.find((c) => c.id === id)!;
    const list = await this.listCategories();
    return (
      list.find((c) => c.id === id) ?? {
        id,
        name: all.name,
        type: all.category_type,
        parentId: all.parent_category_id,
        parent: null,
        icon: null,
      }
    );
  }

  async categoryUsage(id: string) {
    const counted = (r: {
      count: number | null;
      error: { code?: string; message: string } | null;
    }) => {
      // Budgets exist from migration 039 on.
      if (r.error && notMigrated(r.error.code)) return 0;
      check(r.error, "count what uses the category");
      return r.count ?? 0;
    };
    const head = { count: "exact", head: true } as const;
    const ws = this.workspaceId;
    const [transactions, budgets, children] = await Promise.all([
      this.db
        .from("finance_transactions")
        .select("id", head)
        .eq("workspace_id", ws)
        .eq("category_id", id)
        .then(counted),
      this.db
        .from("finance_budgets")
        .select("id", head)
        .eq("workspace_id", ws)
        .eq("category_id", id)
        .then(counted),
      this.db
        .from("finance_categories")
        .select("id", head)
        .eq("workspace_id", ws)
        .eq("parent_category_id", id)
        .then(counted),
    ]);
    return { transactions, budgets, children };
  }

  /**
   * One DELETE, so it's atomic: the FKs keep every movement (category_id → null), lift
   * subcategories to the top level and drop the category's budgets. Movements are never deleted.
   */
  async deleteCategory(id: string) {
    const { data, error } = await this.db
      .from("finance_categories")
      .delete()
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .select("id");
    check(error, "delete the category");
    // The caller resolved it from this workspace's list: no row deleted means RLS has no delete
    // policy yet (migration 048 not applied).
    if (!data?.length) throw needsUpdate();
    this.invalidate();
  }

  async settings() {
    const { data } = await this.db
      .from("finance_settings")
      .select("default_currency, reporting_currency")
      .eq("workspace_id", this.workspaceId)
      .maybeSingle();
    return {
      defaultCurrency: data?.default_currency ?? null,
      reportingCurrency: data?.reporting_currency ?? null,
    };
  }

  async recentCurrencies() {
    const { data } = await this.db
      .from("finance_transactions")
      .select("currency")
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(200);
    const counts = new Map<string, number>();
    for (const r of data ?? []) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }

  async describeImport(importId: string) {
    const { data } = await this.db
      .from("imports")
      .select("source_label, source_reference, imported_rows, status")
      .eq("id", importId)
      .eq("workspace_id", this.workspaceId)
      .maybeSingle();
    if (!data || data.status !== "completed") return null;
    return { label: data.source_label ?? data.source_reference, imported: data.imported_rows };
  }

  async undoImport(importId: string) {
    const info = await this.describeImport(importId);
    if (!info) throw new AppError("NOT_FOUND", "Import not found or already undone");
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from("finance_transactions")
      .update({ archived_at: now })
      .eq("workspace_id", this.workspaceId)
      .eq("import_id", importId)
      .is("archived_at", null)
      .select("id");
    check(error, "undo the import");
    await this.db
      .from("imports")
      .update({ status: "rolled_back", rolled_back_at: now })
      .eq("id", importId)
      .eq("workspace_id", this.workspaceId);
    // Audited by the executor as finance.undoImport (who, when, which import).
    const archived = (data ?? []).length;
    return { archived, label: info.label };
  }

  // ── Books (ADR-052) ─────────────────────────────────────────────────────────

  /** The workspace's Books; "Personal" is created as the default the first time. */
  async listBooks(): Promise<FinanceBook[]> {
    const catalog = await this.load();
    if (!catalog.v2) return [];
    if (!catalog.books.length) {
      const { error } = await this.db.from("finance_books").insert({
        workspace_id: this.workspaceId,
        name: this.locale === "en" ? "Personal" : "Personal",
        book_type: "personal",
        is_default: true,
      });
      // A concurrent first visit created it already.
      if (error && error.code !== "23505") check(error, "prepare the Personal book");
      this.invalidate();
      return (await this.load()).books.map(toBook);
    }
    return catalog.books.map(toBook);
  }

  async saveBook(b: Partial<Omit<FinanceBook, "id">> & { id?: string; archived?: boolean }) {
    const catalog = await this.load();
    if (!catalog.v2) throw needsUpdate();
    const fields = {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.type !== undefined ? { book_type: b.type } : {}),
      ...(b.icon !== undefined ? { icon: b.icon } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.reportingCurrency !== undefined ? { reporting_currency: b.reportingCurrency } : {}),
      ...(b.archived !== undefined
        ? b.archived
          ? {
              status: "archived" as const,
              archived_at: new Date().toISOString(),
              is_default: false,
            }
          : { status: "active" as const, archived_at: null }
        : {}),
    };
    // One default at a time: clearing the old one first keeps the unique index happy.
    if (b.isDefault)
      await this.db
        .from("finance_books")
        .update({ is_default: false })
        .eq("workspace_id", this.workspaceId)
        .eq("is_default", true);
    const query = b.id
      ? this.db
          .from("finance_books")
          .update({ ...fields, ...(b.isDefault !== undefined ? { is_default: b.isDefault } : {}) })
          .eq("id", b.id)
          .eq("workspace_id", this.workspaceId)
      : this.db.from("finance_books").insert({
          workspace_id: this.workspaceId,
          name: b.name ?? "Libro",
          book_type: b.type ?? "other",
          icon: b.icon ?? null,
          description: b.description ?? null,
          reporting_currency: b.reportingCurrency ?? null,
          is_default: Boolean(b.isDefault),
        });
    const { data, error } = await query.select("*").single();
    if (error?.code === "23505")
      throw new AppError("CONFLICT", "There's already a Book with that name", {
        recovery: "review",
        details: { reason: "duplicate_name" },
      });
    check(error, "save the Book");
    this.invalidate();
    return toBook(data!);
  }

  // ── Budgets ─────────────────────────────────────────────────────────────────

  async listBudgets(): Promise<Budget[]> {
    const catalog = await this.load();
    if (!catalog.v2) return [];
    const { data, error } = await this.db
      .from("finance_budgets")
      .select("id, book_id, category_id, subcategory, currency, amount::text")
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null);
    check(error, "load budgets");
    return ((data ?? []) as unknown as Budget[] & Record<string, string>[]).map((r) => {
      const row = r as unknown as {
        id: string;
        book_id: string | null;
        category_id: string;
        subcategory: string | null;
        currency: string;
        amount: string;
      };
      return {
        id: row.id,
        bookId: row.book_id,
        book: catalog.books.find((b) => b.id === row.book_id)?.name ?? null,
        categoryId: row.category_id,
        category: catalog.categories.find((c) => c.id === row.category_id)?.name ?? "—",
        subcategory: row.subcategory,
        currency: row.currency,
        amount: normalizeAmount(String(row.amount)),
      };
    });
  }

  async saveBudget(
    b: Omit<Budget, "id" | "book" | "category"> & { id?: string; archived?: boolean },
  ): Promise<Budget> {
    const { v2 } = await this.load();
    if (!v2) throw needsUpdate();
    const existing = (await this.listBudgets()).find(
      (x) =>
        x.id === b.id ||
        (x.bookId === b.bookId &&
          x.categoryId === b.categoryId &&
          norm(x.subcategory ?? "") === norm(b.subcategory ?? "") &&
          x.currency === b.currency),
    );
    const fields = {
      book_id: b.bookId,
      category_id: b.categoryId,
      subcategory: b.subcategory,
      currency: b.currency,
      amount: normalizeAmount(b.amount),
      ...(b.archived ? { status: "archived" as const, archived_at: new Date().toISOString() } : {}),
    };
    const { data, error } = existing
      ? await this.db
          .from("finance_budgets")
          .update(fields)
          .eq("id", existing.id)
          .eq("workspace_id", this.workspaceId)
          .select("id")
          .single()
      : await this.db
          .from("finance_budgets")
          .insert({ workspace_id: this.workspaceId, ...fields })
          .select("id")
          .single();
    check(error, "save the budget");
    const saved = (await this.listBudgets()).find((x) => x.id === data!.id);
    return (
      saved ?? {
        ...b,
        id: data!.id,
        book: null,
        category: "—",
      }
    );
  }

  // ── Exchange rates ──────────────────────────────────────────────────────────

  async listRates(): Promise<FxRate[]> {
    const { data, error } = await this.db
      .from("finance_fx_rates")
      .select("from_currency, to_currency, rate::text, effective_date")
      .eq("workspace_id", this.workspaceId)
      .order("effective_date", { ascending: false });
    if (error) {
      if (notMigrated(error.code)) return [];
      check(error, "load exchange rates");
    }
    return (
      (data ?? []) as unknown as {
        from_currency: string;
        to_currency: string;
        rate: string;
        effective_date: string;
      }[]
    ).map((r) => ({
      from: r.from_currency,
      to: r.to_currency,
      rate: String(r.rate),
      date: r.effective_date,
    }));
  }

  async saveRate(r: FxRate & { note?: string | null }): Promise<FxRate> {
    const { error } = await this.db.from("finance_fx_rates").upsert(
      {
        workspace_id: this.workspaceId,
        from_currency: r.from,
        to_currency: r.to,
        rate: r.rate,
        effective_date: r.date,
        note: r.note ?? null,
      },
      { onConflict: "workspace_id,from_currency,to_currency,effective_date" },
    );
    if (error && notMigrated(error.code)) throw needsUpdate();
    check(error, "save the exchange rate");
    return { from: r.from, to: r.to, rate: r.rate, date: r.date };
  }
}
