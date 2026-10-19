import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser, migrateFrom } from "./db-harness";

/**
 * Several Ámbitos per movement (ADR-087) against the real migrations: legacy movements carry
 * their Ámbito over, book_id/book_ids stay in step from either side, a deleted Ámbito leaves
 * every movement (never deletes one), and another workspace's Ámbito is refused.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
let personal: string;
let firbot: string;
let legacy: string;

const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));
const one = async <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  (await as<T>(u, sql, args)).rows[0]!;

const book = async (u: typeof alice, name: string) =>
  (
    await one<{ id: string }>(
      u,
      "insert into public.finance_books (workspace_id, name) values ($1, $2) returning id",
      [u.workspaceId, name],
    )
  ).id;

const insertTx = (u: typeof alice, cols: string, vals: string, args: unknown[]) =>
  one<{ id: string; book_id: string | null; book_ids: string[] }>(
    u,
    `insert into public.finance_transactions
       (workspace_id, transaction_type, amount, currency, transaction_date, fingerprint${cols})
     values ($1, 'expense', 100, 'ARS', '2026-10-10', md5(random()::text)${vals})
     returning id, book_id, book_ids`,
    [u.workspaceId, ...args],
  );

const read = (u: typeof alice, id: string) =>
  one<{ book_id: string | null; book_ids: string[] }>(
    u,
    "select book_id, book_ids from public.finance_transactions where id = $1",
    [id],
  );

beforeAll(async () => {
  db = await createTestDatabase("20261104000053");
  alice = await createUser(db, "alice-books@example.com");
  bob = await createUser(db, "bob-books@example.com");
  personal = await book(alice, "Personal");
  firbot = await book(alice, "Firbot");
  // Before the migration: no book_ids column yet.
  legacy = (
    await one<{ id: string }>(
      alice,
      `insert into public.finance_transactions
         (workspace_id, transaction_type, amount, currency, transaction_date, fingerprint, book_id)
       values ($1, 'expense', 100, 'ARS', '2026-10-10', md5(random()::text), $2) returning id`,
      [alice.workspaceId, personal],
    )
  ).id;
  await migrateFrom(db, "20261104000053"); // 053 and later (055: budgets)
});

describe("several Ámbitos per movement", () => {
  it("a legacy movement keeps its Ámbito as its only one", async () => {
    expect(await read(alice, legacy)).toEqual({ book_id: personal, book_ids: [personal] });
  });

  it("book_ids sets the primary; duplicates are dropped, order kept", async () => {
    const t = await insertTx(alice, ", book_ids", ", $2", [[firbot, personal, firbot]]);
    expect(t.book_ids).toEqual([firbot, personal]);
    expect(t.book_id).toBe(firbot);
  });

  it("a single-Ámbito client (book_id only) still works, both ways", async () => {
    const t = await insertTx(alice, ", book_id", ", $2", [personal]);
    expect(t.book_ids).toEqual([personal]);
    await as(alice, "update public.finance_transactions set book_id = $2 where id = $1", [
      t.id,
      firbot,
    ]);
    expect(await read(alice, t.id)).toEqual({ book_id: firbot, book_ids: [firbot] });
    await as(alice, "update public.finance_transactions set book_ids = '{}' where id = $1", [t.id]);
    expect(await read(alice, t.id)).toEqual({ book_id: null, book_ids: [] });
  });

  it("deleting an Ámbito (system only; people archive) keeps every movement and its other Ámbitos", async () => {
    const extra = await book(alice, "Temporal");
    const primary = await insertTx(alice, ", book_ids", ", $2", [[extra, personal]]);
    const secondary = await insertTx(alice, ", book_ids", ", $2", [[personal, extra]]);
    await db.query("delete from public.finance_books where id = $1", [extra]);
    expect(await read(alice, primary.id)).toEqual({ book_id: personal, book_ids: [personal] });
    expect(await read(alice, secondary.id)).toEqual({ book_id: personal, book_ids: [personal] });
  });

  it("combining: movements without an account combine, keeping their Ámbitos", async () => {
    const a = await insertTx(alice, ", book_ids", ", $2", [[personal, firbot]]);
    const b = await insertTx(alice, ", book_ids", ", $2", [[firbot, personal]]);
    const { id } = await one<{ id: string }>(
      alice,
      "select public.finance_combine_transactions($1, 'Peajes', null) as id",
      [[a.id, b.id]],
    );
    const merged = await one<{ amount: string; account_id: string | null; book_ids: string[] }>(
      alice,
      "select amount::text, account_id, book_ids from public.finance_transactions where id = $1",
      [id],
    );
    expect(merged).toMatchObject({ amount: "200.0000", account_id: null });
    expect([...merged.book_ids].sort()).toEqual([personal, firbot].sort());
  });

  it("combining refuses different sets of Ámbitos", async () => {
    const a = await insertTx(alice, ", book_ids", ", $2", [[personal]]);
    const b = await insertTx(alice, ", book_ids", ", $2", [[personal, firbot]]);
    await expect(
      as(alice, "select public.finance_combine_transactions($1, null, null)", [[a.id, b.id]]),
    ).rejects.toThrow(/share account, currency, scope/);
  });

  it("the default account must be one of the workspace's own", async () => {
    const mine = await one<{ id: string }>(
      alice,
      "insert into public.finance_accounts (workspace_id, name) values ($1, 'Mercado Pago') returning id",
      [alice.workspaceId],
    );
    await as(
      alice,
      "insert into public.finance_settings (workspace_id, default_account_id) values ($1, $2) on conflict (workspace_id) do update set default_account_id = excluded.default_account_id",
      [alice.workspaceId, mine.id],
    );
    const bobs = await one<{ id: string }>(
      bob,
      "insert into public.finance_accounts (workspace_id, name) values ($1, 'Bob') returning id",
      [bob.workspaceId],
    );
    await expect(
      as(
        alice,
        "update public.finance_settings set default_account_id = $2 where workspace_id = $1",
        [alice.workspaceId, bobs.id],
      ),
    ).rejects.toThrow(/same workspace/);
  });

  it("a budget covers several Ámbitos, kept in step with its primary", async () => {
    const b = await one<{ book_id: string | null; book_ids: string[] }>(
      alice,
      "insert into public.finance_budgets (workspace_id, currency, amount, book_ids) values ($1, 'ARS', 1000, $2) returning book_id, book_ids",
      [alice.workspaceId, [firbot, personal]],
    );
    expect(b).toEqual({ book_id: firbot, book_ids: [firbot, personal] });
  });

  it("a transfer between currencies keeps both sides; nothing else can have one", async () => {
    const t = await one<{ to_amount: string; to_currency: string }>(
      alice,
      `insert into public.finance_transactions
         (workspace_id, transaction_type, amount, currency, transaction_date, fingerprint, to_amount, to_currency)
       values ($1, 'transfer', 100, 'USD', '2026-10-19', md5(random()::text), 128000, 'ARS')
       returning to_amount::text, to_currency`,
      [alice.workspaceId],
    );
    expect(t).toEqual({ to_amount: "128000.0000", to_currency: "ARS" });
    for (const [type, cur, toCur] of [
      ["expense", "USD", "ARS"], // not a transfer
      ["transfer", "ARS", "ARS"], // same currency
    ])
      await expect(
        as(
          alice,
          `insert into public.finance_transactions
             (workspace_id, transaction_type, amount, currency, transaction_date, fingerprint, to_amount, to_currency)
           values ($1, $2, 100, $3, '2026-10-19', md5(random()::text), 5, $4)`,
          [alice.workspaceId, type, cur, toCur],
        ),
      ).rejects.toThrow(/transfer_fx/);
  });

  it("another workspace's Ámbito is refused", async () => {
    const bobs = await book(bob, "Bob");
    await expect(insertTx(alice, ", book_ids", ", $2", [[personal, bobs]])).rejects.toThrow(
      /same workspace/,
    );
  });
});
