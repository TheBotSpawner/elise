import {
  norm,
  type FinanceProvider,
  type FinanceSourceInfo,
  type FinanceTransaction,
  type TransactionFilter,
} from "@/core/capabilities/finance";
import { AppError } from "@/core/errors";
import { normalizeAmount } from "@/core/finance/money";
import { makeExternalRef, parseExternalRef } from "@/core/providers/refs";
import { check } from "@/infrastructure/providers/elise-native/common";
import type {
  FinanceSourceRow,
  FinanceSourceRowRow,
} from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

const ROW_COLUMNS =
  "id, source_id, row_number, transaction_type, amount::text, currency, transaction_date, description, counterparty, account_name, category_name, subcategory, payment_method, project, status, notes, fingerprint, updated_at";
type Row = Omit<FinanceSourceRowRow, "workspace_id" | "row_key" | "created_at">;
const PAGE = 1000;

const readOnly = () =>
  new AppError(
    "PERMISSION_DENIED",
    "Connected Google Sheets are read-only in ELISE: change it in the sheet.",
    { recovery: "review" },
  );

/**
 * Finance from connected Google Sheets (one Google connection). The sheet stays the source of
 * truth: ELISE reads the normalized rows its last sync mirrored (never the model, never the
 * whole sheet in context) and never writes back. Sources excluded from totals (e.g. also
 * imported into ELISE) are only read when the user names them.
 */
export class GoogleSheetsFinanceProvider implements FinanceProvider {
  readonly readOnly = true;
  private cached?: Promise<FinanceSourceRow[]>;

  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly connectionId: string,
  ) {}

  private all() {
    this.cached ??= (async () => {
      const { data, error } = await this.db
        .from("finance_sources")
        .select("*")
        .eq("workspace_id", this.workspaceId)
        .eq("connection_id", this.connectionId)
        .is("archived_at", null);
      check(error, "load finance sources");
      return data ?? [];
    })();
    return this.cached;
  }

  private info(s: FinanceSourceRow): FinanceSourceInfo {
    return {
      key: s.id,
      name: s.display_name,
      kind: "google_sheets",
      lastSyncedAt: s.last_synced_at,
      included: s.include_in_totals,
    };
  }

  async sources() {
    return (await this.all()).map((s) => this.info(s));
  }

  private shape(r: Row, source: FinanceSourceRow): FinanceTransaction {
    return {
      id: makeExternalRef(this.connectionId, "finance", r.id),
      type: r.transaction_type,
      amount: normalizeAmount(String(r.amount)),
      currency: r.currency,
      date: r.transaction_date,
      description: r.description,
      counterparty: r.counterparty,
      category: r.category_name,
      categoryId: null,
      categoryPath: r.category_name ? [r.category_name] : [],
      subcategory: r.subcategory,
      account: r.account_name,
      accountId: null,
      paymentMethod: r.payment_method,
      project: r.project,
      status: r.status,
      notes: r.notes,
      importId: null,
      readOnly: true,
      fingerprint: r.fingerprint,
      provenance: {
        providerKey: "google",
        connectionId: this.connectionId,
        source: source.display_name,
        sourceId: source.id,
        row: r.row_number,
      },
      updatedAt: r.updated_at,
    };
  }

  async transactions(filter: TransactionFilter, max: number) {
    const sources = (await this.all()).filter((s) =>
      filter.source
        ? norm(s.display_name).includes(norm(filter.source)) ||
          norm(filter.source).includes(norm(s.display_name))
        : s.include_in_totals,
    );
    if (!sources.length) return { rows: [], truncated: false };
    const rows: Row[] = [];
    for (let offset = 0; offset < max; offset += PAGE) {
      let q = this.db
        .from("finance_source_rows")
        .select(ROW_COLUMNS)
        .eq("workspace_id", this.workspaceId)
        .in(
          "source_id",
          sources.map((s) => s.id),
        );
      if (filter.from) q = q.gte("transaction_date", filter.from);
      if (filter.to) q = q.lte("transaction_date", filter.to);
      if (filter.type) q = q.eq("transaction_type", filter.type);
      if (filter.currencies?.length) q = q.in("currency", filter.currencies);
      const { data, error } = await q
        .order("transaction_date", { ascending: false })
        .order("row_number", { ascending: false })
        .range(offset, Math.min(offset + PAGE, max) - 1);
      check(error, "load sheet rows");
      rows.push(...((data ?? []) as unknown as Row[]));
      if ((data ?? []).length < PAGE) break;
      if (rows.length >= max) {
        return { rows: this.shapeAll(rows, sources), truncated: true };
      }
    }
    return { rows: this.shapeAll(rows, sources), truncated: false };
  }

  private shapeAll(rows: Row[], sources: FinanceSourceRow[]) {
    const byId = new Map(sources.map((s) => [s.id, s]));
    return rows.map((r) => this.shape(r, byId.get(r.source_id)!));
  }

  async getTransaction(id: string) {
    const ref = parseExternalRef(id);
    const rowId = ref?.connectionId === this.connectionId ? ref.parts[1] : null;
    if (!rowId || ref?.parts[0] !== "finance") return null;
    const { data } = await this.db
      .from("finance_source_rows")
      .select(ROW_COLUMNS)
      .eq("id", rowId)
      .eq("workspace_id", this.workspaceId)
      .maybeSingle();
    if (!data) return null;
    const source = (await this.all()).find((s) => s.id === (data as unknown as Row).source_id);
    return source ? this.shape(data as unknown as Row, source) : null;
  }

  async listAccounts() {
    return [];
  }
  async listCategories() {
    return [];
  }
  async settings() {
    return { defaultCurrency: null, reportingCurrency: null };
  }
  async recentCurrencies() {
    return [];
  }
  async describeImport() {
    return null;
  }
  async createTransaction(): Promise<never> {
    throw readOnly();
  }
  async updateTransaction(): Promise<never> {
    throw readOnly();
  }
  async archiveTransaction(): Promise<never> {
    throw readOnly();
  }
  async updateAccount(): Promise<never> {
    throw readOnly();
  }
  async createAccount(): Promise<never> {
    throw readOnly();
  }
  async createCategory(): Promise<never> {
    throw readOnly();
  }
  async undoImport(): Promise<never> {
    throw readOnly();
  }
}
