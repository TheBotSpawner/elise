import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";

import { FakeSupabase } from "../fixtures/fake-supabase";

/**
 * The import service end to end over an in-memory database (ADR-073): one decision per name,
 * new accounts created once, transfers between accounts, ambiguous names held for the user,
 * aliases remembered, retries that never duplicate, and overlapping history skipped.
 */

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ db: null as unknown, files: new Map<string, string>() }));
vi.mock("@/infrastructure/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/infrastructure/supabase/storage", () => ({
  downloadFinanceImport: async (_ws: string, path: string) =>
    new TextEncoder().encode(state.files.get(path) ?? ""),
  removeFinanceImport: async () => undefined,
  createFinanceUploadUrl: async () => ({ path: "p", token: "t" }),
  financeImportPath: (_ws: string, id: string) => id,
}));
vi.mock("@/application/background", () => ({
  workspaceContext: async () => ({ db: state.db, workspaceId: WS, userId: ME }),
}));
vi.mock("@/application/elise", () => ({ googleHttpFor: vi.fn() }));
vi.mock("@/infrastructure/ai", () => ({
  getAIProvider: () => {
    throw new Error("no AI in tests: rules only");
  },
}));
vi.mock("@/infrastructure/background/trigger/runtime", () => ({
  isBackgroundConfigured: () => false,
  TriggerDevBackgroundRuntime: class {},
}));

const WS = "ws-1";
const ME = "user-1";
const EF = "11111111-1111-4111-8111-111111111111";
const BN = "22222222-2222-4222-8222-222222222222";
const BG = "33333333-3333-4333-8333-333333333333";
const COMIDA = "44444444-4444-4444-8444-444444444444";

const {
  confirmFinanceImport,
  financeImportStatus,
  inspectImport,
  previewFinanceImport,
  runFinanceImport,
} = await import("@/application/finance-import");

const FILE = [
  "Date,Account,Category,Note,Amount,Currency,Income/Expense",
  "2026-03-01,Cash,🍜 Food,Lunch,12.50,USD,Expense",
  "2026-03-02,Cash,Food,Dinner,20,USD,Expense",
  "2026-03-03,Banco Galicia,Salary,March,2000,USD,Income",
  "2026-03-04,Banco Galicia,Cash,Retiro,100,USD,Transfer-Out",
  "2026-03-05,Banco,Food,Ambiguo,5,USD,Expense",
  "2026-03-06,NaranjaX,Food,Snack,7,USD,Expense",
  "2026-03-07,Cash,Food,Broken,abc,USD,Expense",
].join("\n");

let db: FakeSupabase;
let auth: AuthContext;

beforeEach(() => {
  db = new FakeSupabase();
  state.db = db;
  state.files.clear();
  db.rows("finance_accounts").push(
    { id: EF, workspace_id: WS, name: "Efectivo", archived_at: null },
    { id: BN, workspace_id: WS, name: "Banco Nación", archived_at: null },
    { id: BG, workspace_id: WS, name: "Banco Galicia", archived_at: null },
  );
  db.rows("finance_categories").push({
    id: COMIDA,
    workspace_id: WS,
    name: "Comida",
    category_type: "expense",
    archived_at: null,
  });
  db.defaults.finance_transactions = { archived_at: null };
  auth = { db, workspaceId: WS, userId: ME } as unknown as AuthContext;
});

function newImport(id: string, csv: string) {
  state.files.set(id, csv);
  db.rows("imports").push({
    id,
    workspace_id: WS,
    status: "uploaded",
    source_type: "csv",
    source_reference: `${id}.csv`,
    source_label: `${id}.csv`,
    file_path: id,
    mapping_config: {},
    created_by_user_id: ME,
    total_rows: 0,
    valid_rows: 0,
    invalid_rows: 0,
    duplicate_rows: 0,
    imported_rows: 0,
  });
}

async function analyze(id: string, entities?: unknown) {
  const inspection = await inspectImport(auth, id);
  const mapping = entities ? { ...inspection.mapping, entities } : inspection.mapping;
  return { inspection, preview: await previewFinanceImport(auth, id, mapping) };
}

const txs = () => db.rows("finance_transactions");

describe("finance migration, end to end", () => {
  it("resolves each name once, creates what's new, holds what's ambiguous, imports the rest", async () => {
    newImport("imp-1", FILE);
    const { inspection, preview } = await analyze("imp-1");
    expect(inspection.ignored).toEqual([]);
    const account = (raw: string) => preview.entities.accounts.find((a) => a.raw === raw)!;
    expect(account("Cash")).toMatchObject({ how: "synonym", id: EF, name: "Efectivo" });
    expect(account("Banco Galicia")).toMatchObject({ how: "exact", id: BG });
    expect(account("NaranjaX")).toMatchObject({ how: "created", id: null });
    expect(account("Banco")).toMatchObject({ how: "review" });
    const food = preview.entities.categories.find((c) => c.key === "food")!;
    expect(food).toMatchObject({ id: COMIDA, rows: 4 });
    expect(preview).toMatchObject({ review: 1, invalid: 1, willImport: 5 });

    await confirmFinanceImport(auth, "imp-1");
    const status = await financeImportStatus(auth, "imp-1");
    expect(status).toMatchObject({ status: "completed", imported: 5, review: 1, invalid: 2 });

    const byNote = (note: string) => txs().find((t) => t.description === note)!;
    expect(byNote("Lunch")).toMatchObject({ account_id: EF, category_id: COMIDA });
    // A transfer between two accounts: no category, nothing counted as spending.
    expect(byNote("Retiro")).toMatchObject({
      transaction_type: "transfer",
      account_id: BG,
      to_account_id: EF,
      category_id: null,
    });
    // One new account and one new category, however many rows use them.
    const created = db.rows("finance_accounts").filter((a) => a.source === "import");
    expect(created.map((a) => a.name)).toEqual(["NaranjaX"]);
    expect(
      db
        .rows("finance_categories")
        .filter((c) => c.source === "import")
        .map((c) => c.name),
    ).toEqual(["Salary"]);
    // Every movement says where it came from.
    expect(byNote("Snack")).toMatchObject({ import_id: "imp-1", import_row_number: 7 });
    // "Cash" and "Food" are remembered for this person: next time, no question.
    const aliases = db.rows("user_preferences").find((p) => p.key === "finance.import.aliases");
    expect(aliases?.value_json).toEqual({
      accounts: { cash: EF },
      categories: { "expense|food": COMIDA },
    });
  });

  it("the user's choice for an ambiguous name applies to every row that uses it", async () => {
    newImport("imp-2", FILE);
    const { preview } = await analyze("imp-2", {
      accounts: { banco: { action: "match", id: BN } },
      categories: {},
    });
    expect(preview).toMatchObject({ review: 0, willImport: 6 });
  });

  it("a retry never writes a movement twice", async () => {
    newImport("imp-3", FILE);
    await analyze("imp-3");
    await confirmFinanceImport(auth, "imp-3");
    expect(txs()).toHaveLength(5);
    // Trigger retries the same job (or a second click arrives): it starts over, cleanly.
    db.rows("imports").find((i) => i.id === "imp-3")!.status = "importing";
    await runFinanceImport(WS, "imp-3");
    expect(txs()).toHaveLength(5);
    await expect(confirmFinanceImport(auth, "imp-3")).rejects.toThrow(/already ran/);
  });

  it("importing overlapping history again only adds what's new", async () => {
    newImport("imp-4", FILE);
    await analyze("imp-4");
    await confirmFinanceImport(auth, "imp-4");
    newImport("imp-5", `${FILE}\n2026-03-08,Cash,Food,Breakfast,9,USD,Expense`);
    const { preview } = await analyze("imp-5");
    expect(preview).toMatchObject({ duplicates: 5, willImport: 1 });
    await confirmFinanceImport(auth, "imp-5");
    expect(await financeImportStatus(auth, "imp-5")).toMatchObject({ imported: 1, duplicates: 5 });
    expect(txs()).toHaveLength(6);
  });

  it("a transfer whose other side isn't an account waits for the user", async () => {
    newImport(
      "imp-6",
      "Date,Account,Category,Note,Amount,Currency,Type\n2026-03-01,Cash,Transferencias,Mover,50,USD,Transfer-Out",
    );
    const { preview } = await analyze("imp-6");
    expect(preview).toMatchObject({ review: 1, willImport: 0 });
    expect(preview.entities.accounts.find((a) => a.raw === "Transferencias")).toMatchObject({
      how: "review",
    });
  });
});
