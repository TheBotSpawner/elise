import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser, migrateFrom } from "./db-harness";

/**
 * Finance v3 (ADR-083) against the real migrations: category deletion that keeps every
 * movement, normalized names, combined movements with provenance and undo, multi-category
 * budgets (legacy ones carried over) — and nothing crosses workspaces.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
let legacyBudget: string;
let legacyCategory: string;

const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));
const one = async <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  (await as<T>(u, sql, args)).rows[0]!;

async function account(u: typeof alice, name: string) {
  return (
    await one<{ id: string }>(
      u,
      "insert into public.finance_accounts (workspace_id, name) values ($1, $2) returning id",
      [u.workspaceId, name],
    )
  ).id;
}
async function category(u: typeof alice, name: string, type = "expense") {
  return (
    await one<{ id: string }>(
      u,
      "insert into public.finance_categories (workspace_id, name, category_type) values ($1, $2, $3) returning id",
      [u.workspaceId, name, type],
    )
  ).id;
}
async function tx(
  u: typeof alice,
  o: {
    type: "income" | "expense";
    amount: string;
    account?: string | null;
    category?: string | null;
    currency?: string;
    date?: string;
    importId?: string;
  },
) {
  return (
    await one<{ id: string }>(
      u,
      `insert into public.finance_transactions
         (workspace_id, transaction_type, amount, currency, transaction_date, account_id, category_id, fingerprint, external_reference)
       values ($1, $2, $3, $4, $5, $6, $7, md5(random()::text), $8) returning id`,
      [
        u.workspaceId,
        o.type,
        o.amount,
        o.currency ?? "ARS",
        o.date ?? "2026-10-10",
        o.account ?? null,
        o.category ?? null,
        o.importId ?? null,
      ],
    )
  ).id;
}

beforeAll(async () => {
  // A legacy single-category budget exists before the migration…
  db = await createTestDatabase("20261103000052");
  alice = await createUser(db, "alice-fin3@example.com");
  bob = await createUser(db, "bob-fin3@example.com");
  legacyCategory = await category(alice, "Restaurantes");
  legacyBudget = (
    await one<{ id: string }>(
      alice,
      "insert into public.finance_budgets (workspace_id, category_id, currency, amount) values ($1, $2, 'ARS', 200000) returning id",
      [alice.workspaceId, legacyCategory],
    )
  ).id;
  // …then migration 052 runs.
  await migrateFrom(db, "20261103000052");
});

describe("budgets", () => {
  it("a legacy budget keeps its category as its first link", async () => {
    const links = await as<{ category_id: string }>(
      alice,
      "select category_id from public.finance_budget_categories where budget_id = $1",
      [legacyBudget],
    );
    expect(links.rows.map((r) => r.category_id)).toEqual([legacyCategory]);
  });

  it("one budget over several categories, with a name and an icon; never another workspace's", async () => {
    const bares = await category(alice, "Bares");
    const ocio = await category(alice, "Entretenimiento");
    const b = await one<{ id: string }>(
      alice,
      "insert into public.finance_budgets (workspace_id, name, icon, currency, amount) values ($1, 'Salidas', '🍽️', 'ARS', 200000) returning id",
      [alice.workspaceId],
    );
    for (const c of [bares, ocio])
      await as(
        alice,
        "insert into public.finance_budget_categories (budget_id, category_id, workspace_id) values ($1, $2, $3)",
        [b.id, c, alice.workspaceId],
      );
    expect(
      (
        await as(alice, "select * from public.finance_budget_categories where budget_id = $1", [
          b.id,
        ])
      ).rows,
    ).toHaveLength(2);
    expect((await as(bob, "select * from public.finance_budget_categories")).rows).toHaveLength(0);
    // Bob can't link his budget to Alice's category (or into her workspace).
    const bobBudget = await one<{ id: string }>(
      bob,
      "insert into public.finance_budgets (workspace_id, currency, amount) values ($1, 'ARS', 1) returning id",
      [bob.workspaceId],
    );
    await expect(
      as(
        bob,
        "insert into public.finance_budget_categories (budget_id, category_id, workspace_id) values ($1, $2, $3)",
        [bobBudget.id, bares, bob.workspaceId],
      ),
    ).rejects.toThrow();
  });
});

describe("category names", () => {
  it("same normalized name and type collide; another type doesn't", async () => {
    await category(alice, "Regalos");
    await expect(category(alice, "  regalos ")).rejects.toThrow(/duplicate|unique/);
    await expect(category(alice, "REGALOS")).rejects.toThrow(/duplicate|unique/);
    await expect(category(alice, "Regalos", "income")).resolves.toBeTruthy();
  });
});

describe("deleting a category", () => {
  it("keeps every movement (uncategorized), archives budgets left empty, deletes the category", async () => {
    const cat = await category(alice, "Gift");
    const acc = await account(alice, "Billetera");
    const ids = [
      await tx(alice, { type: "expense", amount: "10", account: acc, category: cat }),
      await tx(alice, { type: "expense", amount: "5", account: acc, category: cat }),
    ];
    const only = await one<{ id: string }>(
      alice,
      "insert into public.finance_budgets (workspace_id, name, currency, amount) values ($1, 'Solo Gift', 'ARS', 100) returning id",
      [alice.workspaceId],
    );
    await as(alice, "insert into public.finance_budget_categories values ($1, $2, $3)", [
      only.id,
      cat,
      alice.workspaceId,
    ]);

    const r = await one<{ result: { uncategorized: number; budgetsArchived: number } }>(
      alice,
      "select public.finance_delete_category($1) as result",
      [cat],
    );
    expect(r.result).toEqual({ uncategorized: 2, budgetsArchived: 1 });
    const rows = await as<{ category_id: string | null; archived_at: string | null }>(
      alice,
      "select category_id, archived_at from public.finance_transactions where id = any($1)",
      [ids],
    );
    expect(rows.rows).toEqual([
      { category_id: null, archived_at: null },
      { category_id: null, archived_at: null },
    ]);
    expect(
      (await as(alice, "select 1 from public.finance_categories where id = $1", [cat])).rows,
    ).toHaveLength(0);
    expect(
      (
        await one<{ status: string }>(
          alice,
          "select status from public.finance_budgets where id = $1",
          [only.id],
        )
      ).status,
    ).toBe("archived");
  });

  it("another workspace can't delete it, null its movements or even learn it exists", async () => {
    const cat = await category(alice, "Privada");
    const t = await tx(alice, { type: "expense", amount: "1", category: cat });
    await expect(as(bob, "select public.finance_delete_category($1)", [cat])).rejects.toThrow(
      /not found/,
    );
    expect(
      (
        await one<{ category_id: string }>(
          alice,
          "select category_id from public.finance_transactions where id = $1",
          [t],
        )
      ).category_id,
    ).toBe(cat);
  });
});

describe("combining movements", () => {
  it("one account, one currency → signed sum, latest date, sources hidden and linked; undo restores", async () => {
    const mp = await account(alice, "Mercado Pago");
    const src = [
      await tx(alice, {
        type: "income",
        amount: "10000",
        account: mp,
        date: "2026-10-01",
        importId: "mp-1",
      }),
      await tx(alice, { type: "expense", amount: "2000", account: mp, date: "2026-10-03" }),
      await tx(alice, { type: "expense", amount: "1500.25", account: mp, date: "2026-10-02" }),
    ];
    const id = (
      await one<{ id: string }>(
        alice,
        "select public.finance_combine_transactions($1, 'Movimiento combinado', null) as id",
        [src],
      )
    ).id;
    const merged = await one<{
      transaction_type: string;
      amount: string;
      transaction_date: string;
      merged_source_count: number;
      account_id: string;
    }>(
      alice,
      "select transaction_type, amount::text, transaction_date::text, merged_source_count, account_id from public.finance_transactions where id = $1",
      [id],
    );
    expect(merged).toEqual({
      transaction_type: "income",
      amount: "6499.7500",
      transaction_date: "2026-10-03",
      merged_source_count: 3,
      account_id: mp,
    });
    const sources = await as<{
      merged_into_transaction_id: string;
      archived_at: string | null;
      external_reference: string | null;
    }>(
      alice,
      "select merged_into_transaction_id, archived_at, external_reference from public.finance_transactions where id = any($1) order by transaction_date",
      [src],
    );
    expect(sources.rows.every((r) => r.merged_into_transaction_id === id && r.archived_at)).toBe(
      true,
    );
    expect(sources.rows[0]!.external_reference).toBe("mp-1"); // import provenance kept

    // A merged source can't be combined again.
    await expect(
      as(alice, "select public.finance_combine_transactions($1, null, null)", [[src[0], src[1]]]),
    ).rejects.toThrow();

    const restored = await one<{ n: number }>(
      alice,
      "select public.finance_uncombine_transaction($1) as n",
      [id],
    );
    expect(restored.n).toBe(3);
    const after = await as<{
      archived_at: string | null;
      merged_into_transaction_id: string | null;
    }>(
      alice,
      "select archived_at, merged_into_transaction_id from public.finance_transactions where id = any($1)",
      [src],
    );
    expect(after.rows.every((r) => !r.archived_at && !r.merged_into_transaction_id)).toBe(true);
    expect(
      (
        await one<{ archived_at: string | null }>(
          alice,
          "select archived_at from public.finance_transactions where id = $1",
          [id],
        )
      ).archived_at,
    ).not.toBeNull();
  });

  it("refuses different accounts, currencies, transfers, zero results — and changes nothing", async () => {
    const a = await account(alice, "Banco Nación");
    const b = await account(alice, "Brubank");
    const x = await tx(alice, { type: "expense", amount: "1", account: a });
    const y = await tx(alice, { type: "expense", amount: "1", account: b });
    const z = await tx(alice, { type: "expense", amount: "1", account: a, currency: "USD" });
    const inc = await tx(alice, { type: "income", amount: "1", account: a });
    const fail = (ids: string[]) =>
      as(alice, "select public.finance_combine_transactions($1, null, null)", [ids]);
    await expect(fail([x, y])).rejects.toThrow(/share account/);
    await expect(fail([x, z])).rejects.toThrow(/share account/);
    await expect(fail([x, inc])).rejects.toThrow(/zero/);
    await expect(fail([x])).rejects.toThrow(/between 2/);
    const transfer = await one<{ id: string }>(
      alice,
      `insert into public.finance_transactions (workspace_id, transaction_type, amount, currency, transaction_date, account_id, to_account_id, fingerprint)
       values ($1, 'transfer', 1, 'ARS', '2026-10-10', $2, $3, 'tr') returning id`,
      [alice.workspaceId, a, b],
    );
    await expect(fail([x, transfer.id])).rejects.toThrow(/only active income or expense/);
    const untouched = await as<{ archived_at: string | null }>(
      alice,
      "select archived_at from public.finance_transactions where id = any($1)",
      [[x, y, z, inc]],
    );
    expect(untouched.rows.every((r) => r.archived_at === null)).toBe(true);
  });

  it("another workspace's movements are invisible to combine", async () => {
    const acc = await account(alice, "Caja");
    const ids = [
      await tx(alice, { type: "expense", amount: "1", account: acc }),
      await tx(alice, { type: "expense", amount: "2", account: acc }),
    ];
    await expect(
      as(bob, "select public.finance_combine_transactions($1, null, null)", [ids]),
    ).rejects.toThrow(/not found/);
  });
});
