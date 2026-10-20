import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser, migrateFrom } from "./db-harness";

/**
 * ADR-101: an account's recorded balance against the real migrations — opening balance plus the
 * completed, active movements through a day; transfers move money between two accounts; nothing
 * is converted, nothing is counted twice, and RLS keeps every workspace's balances its own.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
let legacy: string;

type U = { userId: string; workspaceId: string };
const as = <T>(u: U, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));

async function account(
  u: U,
  name: string,
  currency: string | null,
  opening?: string,
  from?: string,
) {
  const r = await as<{ id: string }>(
    u,
    `insert into public.finance_accounts (workspace_id, name, currency, opening_balance, opening_balance_date)
     values ($1, $2, $3, coalesce($4::numeric, 0), $5::date) returning id`,
    [u.workspaceId, name, currency, opening ?? null, from ?? null],
  );
  return r.rows[0]!.id;
}

async function tx(
  u: U,
  o: {
    type: "income" | "expense" | "transfer";
    amount: string;
    account: string;
    currency?: string;
    date?: string;
    to?: string;
    toAmount?: string;
    toCurrency?: string;
    status?: "completed" | "pending" | "cancelled";
  },
) {
  const r = await as<{ id: string }>(
    u,
    `insert into public.finance_transactions
       (workspace_id, transaction_type, amount, currency, transaction_date, account_id, to_account_id,
        to_amount, to_currency, status, fingerprint)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, md5(random()::text)) returning id`,
    [
      u.workspaceId,
      o.type,
      o.amount,
      o.currency ?? "ARS",
      o.date ?? "2026-10-10",
      o.account,
      o.to ?? null,
      o.toAmount ?? null,
      o.toCurrency ?? null,
      o.status ?? "completed",
    ],
  );
  return r.rows[0]!.id;
}

interface Row {
  account_id: string;
  currency: string;
  opening: string;
  balance: string;
  pending: string;
  pending_count: number;
  counted: number;
}

async function balances(u: U, asOf = "2026-12-31", ws = u.workspaceId) {
  return (await as<Row>(u, "select * from public.finance_account_balances($1, $2)", [ws, asOf]))
    .rows;
}
async function balance(u: U, id: string, currency = "ARS", asOf?: string) {
  return (await balances(u, asOf)).find((r) => r.account_id === id && r.currency === currency);
}

beforeAll(async () => {
  // An account that existed before balances…
  db = await createTestDatabase("20261110000059");
  alice = await createUser(db, "alice-bal@example.com");
  bob = await createUser(db, "bob-bal@example.com");
  legacy = (
    await as<{ id: string }>(
      alice,
      "insert into public.finance_accounts (workspace_id, name, currency) values ($1, 'Caja', 'ARS') returning id",
      [alice.workspaceId],
    )
  ).rows[0]!.id;
  await tx(alice, { type: "income", amount: "1500", account: legacy });
  // …then migration 059 runs.
  await migrateFrom(db, "20261110000059");
});

describe("finance_account_balances", () => {
  it("keeps existing accounts as they were: opening 0, not set by anyone, every movement counts", async () => {
    const r = await as<{ opening_balance: string; opening_balance_set_at: string | null }>(
      alice,
      "select opening_balance::text, opening_balance_set_at from public.finance_accounts where id = $1",
      [legacy],
    );
    expect(r.rows[0]).toMatchObject({ opening_balance: "0.0000", opening_balance_set_at: null });
    expect((await balance(alice, legacy))?.balance).toBe("1500.0000");
  });

  it("a new account with no movements is 0 in its currency", async () => {
    const id = await account(alice, "Vacía", "ARS");
    expect(await balance(alice, id)).toMatchObject({ balance: "0.0000", counted: 0 });
  });

  it("opening 10,000 + 5,000 − 2,000 = 13,000, whatever the month", async () => {
    const mp = await account(alice, "Mercado Pago", "ARS", "10000");
    await tx(alice, { type: "income", amount: "5000", account: mp, date: "2026-01-10" });
    await tx(alice, { type: "expense", amount: "2000", account: mp, date: "2026-10-02" });
    expect((await balance(alice, mp))?.balance).toBe("13000.0000");
  });

  it("a transfer moves money between two accounts (in two currencies too); never income", async () => {
    const a = await account(alice, "Banco A", "ARS", "1000");
    const b = await account(alice, "Banco B", "ARS");
    const usd = await account(alice, "Wise", "USD");
    await tx(alice, { type: "transfer", amount: "300", account: a, to: b });
    await tx(alice, {
      type: "transfer",
      amount: "100",
      currency: "USD",
      account: usd,
      to: a,
      toAmount: "128000",
      toCurrency: "ARS",
    });
    expect((await balance(alice, a))?.balance).toBe("128700.0000");
    expect((await balance(alice, b))?.balance).toBe("300.0000");
    expect((await balance(alice, usd, "USD"))?.balance).toBe("-100.0000");
  });

  it("archived, combined-away and cancelled movements never count; pending ones are apart", async () => {
    const id = await account(alice, "Billetera", "ARS");
    await tx(alice, { type: "income", amount: "100", account: id });
    const gone = await tx(alice, { type: "expense", amount: "40", account: id });
    await as(alice, "update public.finance_transactions set archived_at = now() where id = $1", [
      gone,
    ]);
    const a1 = await tx(alice, { type: "expense", amount: "10", account: id });
    const a2 = await tx(alice, { type: "expense", amount: "5", account: id });
    // Combined: the sources are hidden, only the combined movement (−15) counts.
    await as(alice, "select public.finance_combine_transactions($1, 'Café', null)", [[a1, a2]]);
    await tx(alice, { type: "expense", amount: "7", account: id, status: "pending" });
    await tx(alice, { type: "expense", amount: "9", account: id, status: "cancelled" });
    expect(await balance(alice, id)).toMatchObject({
      balance: "85.0000",
      pending: "-7.0000",
      pending_count: 1,
    });
  });

  it("a movement in another currency is its own row, never converted", async () => {
    const id = await account(alice, "Tarjeta", "ARS", "500");
    await tx(alice, { type: "expense", amount: "12.5", currency: "USD", account: id });
    expect((await balance(alice, id, "ARS"))?.balance).toBe("500.0000");
    expect(await balance(alice, id, "USD")).toMatchObject({ balance: "-12.5000", opening: "0" });
  });

  it("the opening date: earlier movements are inside it; history as of a day", async () => {
    const id = await account(alice, "Efectivo", "ARS", "1000", "2026-10-01");
    await tx(alice, { type: "income", amount: "400", account: id, date: "2026-09-30" });
    await tx(alice, { type: "expense", amount: "100", account: id, date: "2026-10-01" });
    await tx(alice, { type: "expense", amount: "50", account: id, date: "2026-10-15" });
    expect((await balance(alice, id, "ARS", "2026-10-10"))?.balance).toBe("900.0000");
    expect((await balance(alice, id))?.balance).toBe("850.0000");
  });

  it("exact decimals (0.1 + 0.2)", async () => {
    const id = await account(alice, "Decimales", "ARS");
    await tx(alice, { type: "income", amount: "0.1", account: id });
    await tx(alice, { type: "income", amount: "0.2", account: id });
    expect((await balance(alice, id))?.balance).toBe("0.3000");
  });

  it("an opening balance needs the account's currency", async () => {
    await expect(account(alice, "Sin moneda", null, "5")).rejects.toThrow();
  });

  it("RLS: another workspace's balances are invisible, even asking for its id", async () => {
    const theirs = await account(bob, "Mercado Pago", "ARS", "77");
    expect((await balance(bob, theirs))?.balance).toBe("77.0000");
    expect(await balances(alice, "2026-12-31", bob.workspaceId)).toEqual([]);
    expect((await balances(alice)).some((r) => r.account_id === theirs)).toBe(false);
  });
});
