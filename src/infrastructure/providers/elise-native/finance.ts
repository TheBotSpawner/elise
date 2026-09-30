import {
  fingerprint,
  NATIVE_SOURCE_NAME,
  norm,
  STARTER_CATEGORIES,
  type AccountType,
  type CategoryType,
  type FinanceAccount,
  type FinanceCategory,
  type FinanceProvider,
  type FinanceTransaction,
  type NewTransaction,
  type TransactionFilter,
  type TransactionPatch,
} from "@/core/capabilities/finance";
import type { EntrySource } from "@/core/capabilities/habits";
import { AppError } from "@/core/errors";
import { normalizeAmount } from "@/core/finance/money";
import type {
  FinanceAccountRow,
  FinanceCategoryRow,
  FinanceTransactionRow,
} from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import { check } from "./common";

/** numeric is read as text so no amount ever passes through a float. */
export const TRANSACTION_COLUMNS =
  "id, transaction_type, amount::text, currency, transaction_date, description, counterparty, account_id, category_id, subcategory, payment_method, project, status, notes, import_id, import_row_number, fingerprint, updated_at";

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
>;

const PAGE = 1000;
const UUID = /^[0-9a-f-]{36}$/i;

const toAccount = (r: FinanceAccountRow): FinanceAccount => ({
  id: r.id,
  name: r.name,
  type: r.account_type,
  currency: r.currency,
});

/** ELISE Finance (Native provider): the workspace's own ledger. */
export class EliseFinanceProvider implements FinanceProvider {
  readonly readOnly = false;
  private catalog?: Promise<{ accounts: FinanceAccountRow[]; categories: FinanceCategoryRow[] }>;

  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
    private readonly connectionId: string,
    private readonly locale: "es" | "en",
  ) {}

  private load() {
    this.catalog ??= (async () => {
      const [accounts, categories] = await Promise.all([
        this.db.from("finance_accounts").select("*").eq("workspace_id", this.workspaceId),
        this.db.from("finance_categories").select("*").eq("workspace_id", this.workspaceId),
      ]);
      check(accounts.error, "load accounts");
      check(categories.error, "load categories");
      return { accounts: accounts.data ?? [], categories: categories.data ?? [] };
    })();
    return this.catalog;
  }

  private invalidate() {
    this.catalog = undefined;
  }

  private shape(
    r: TxRow,
    catalog: { accounts: FinanceAccountRow[]; categories: FinanceCategoryRow[] },
  ): FinanceTransaction {
    const byId = new Map(catalog.categories.map((c) => [c.id, c]));
    const path: string[] = [];
    let cursor = r.category_id ? byId.get(r.category_id) : undefined;
    for (let depth = 0; cursor && depth < 8; depth++) {
      path.unshift(cursor.name);
      cursor = cursor.parent_category_id ? byId.get(cursor.parent_category_id) : undefined;
    }
    const account = catalog.accounts.find((a) => a.id === r.account_id);
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

  async transactions(filter: TransactionFilter, max: number) {
    if (filter.source && !norm(NATIVE_SOURCE_NAME).includes(norm(filter.source))) {
      if (!norm(filter.source).includes("elise")) return { rows: [], truncated: false };
    }
    const catalog = await this.load();
    const rows: TxRow[] = [];
    for (let offset = 0; offset < max; offset += PAGE) {
      let q = this.db
        .from("finance_transactions")
        .select(TRANSACTION_COLUMNS)
        .eq("workspace_id", this.workspaceId)
        .is("archived_at", null);
      if (filter.from) q = q.gte("transaction_date", filter.from);
      if (filter.to) q = q.lte("transaction_date", filter.to);
      if (filter.type) q = q.eq("transaction_type", filter.type);
      if (filter.currencies?.length) q = q.in("currency", filter.currencies);
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
    const { data } = await this.db
      .from("finance_transactions")
      .select(TRANSACTION_COLUMNS)
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    return data ? this.shape(data as unknown as TxRow, await this.load()) : null;
  }

  async createTransaction(t: NewTransaction, source: EntrySource) {
    const { data, error } = await this.db
      .from("finance_transactions")
      .insert({
        workspace_id: this.workspaceId,
        transaction_type: t.type,
        amount: normalizeAmount(t.amount),
        currency: t.currency,
        transaction_date: t.date,
        description: t.description ?? null,
        counterparty: t.counterparty ?? null,
        account_id: t.accountId ?? null,
        category_id: t.categoryId ?? null,
        subcategory: t.subcategory ?? null,
        payment_method: t.paymentMethod ?? null,
        project: t.project ?? null,
        status: t.status ?? "completed",
        notes: t.notes ?? null,
        source,
        import_id: t.importId ?? null,
        import_row_number: t.importRow ?? null,
        external_reference: t.externalReference ?? null,
        fingerprint: fingerprint(t),
        created_by_user_id: this.userId,
      })
      .select(TRANSACTION_COLUMNS)
      .single();
    check(error, "record the transaction");
    return this.shape(data as unknown as TxRow, await this.load());
  }

  async updateTransaction(id: string, p: TransactionPatch) {
    const current = await this.getTransaction(id);
    if (!current) throw new AppError("NOT_FOUND", "Transaction not found");
    const next = {
      type: p.type ?? current.type,
      amount: p.amount ?? current.amount,
      currency: p.currency ?? current.currency,
      date: p.date ?? current.date,
      counterparty: p.counterparty !== undefined ? p.counterparty : current.counterparty,
      description: p.description !== undefined ? p.description : current.description,
    };
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
        ...set("counterparty", p.counterparty),
        ...set("account_id", p.accountId),
        ...set("category_id", p.categoryId),
        ...set("subcategory", p.subcategory),
        ...set("payment_method", p.paymentMethod),
        ...set("project", p.project),
        ...set("status", p.status),
        ...set("notes", p.notes),
        fingerprint: fingerprint(next),
      })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .select(TRANSACTION_COLUMNS)
      .single();
    check(error, "update the transaction");
    return this.shape(data as unknown as TxRow, await this.load());
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
      }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  }

  async createCategory(
    c: { name: string; type: CategoryType; parentId: string | null },
    source: EntrySource,
  ) {
    const existing = (await this.listCategories()).find(
      (x) => norm(x.name) === norm(c.name) && x.type === c.type,
    );
    if (existing) return existing;
    const { data, error } = await this.db
      .from("finance_categories")
      .insert({
        workspace_id: this.workspaceId,
        name: c.name,
        category_type: c.type,
        parent_category_id: c.parentId,
        source,
      })
      .select("*")
      .single();
    check(error, "add the category");
    this.invalidate();
    const categories = await this.listCategories();
    return categories.find((x) => x.id === data!.id)!;
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
}
