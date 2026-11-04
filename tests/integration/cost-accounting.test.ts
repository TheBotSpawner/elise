import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser } from "./db-harness";

/** ADR-138 (migration 070): the ledger, the gate and who can touch them, on real SQL and RLS. */
let db: PGlite;
let a: { userId: string; workspaceId: string };
let b: { userId: string; workspaceId: string };

const key = () => crypto.randomUUID();

const reserve = async (
  who: { userId: string | null; workspaceId: string },
  amount: number,
  opts: { key?: string; enforce?: boolean; modality?: string } = {},
) =>
  (
    await db.query<{ reservation_id: string; allowed: boolean; reason: string | null }>(
      "select * from public.reserve_budget($1, $2, $3, $4, $5, $6)",
      [
        opts.key ?? key(),
        who.userId,
        who.workspaceId,
        opts.modality ?? "chat",
        amount,
        opts.enforce ?? true,
      ],
    )
  ).rows[0]!;

const release = (id: string) => db.query("select public.release_budget($1)", [id]);

const record = (
  who: { userId: string | null; workspaceId: string },
  micro: number,
  extra: { key?: string; costUsd?: number } = {},
) =>
  db.query(
    `insert into public.usage_events (workspace_id, user_id, feature, operation, provider, modality,
       budget_micro, cost_status, price_version, idempotency_key, estimated_cost_usd)
     values ($1, $2, 'chat', 'llm', 'openai', 'chat', $3, 'actual', 'v1', $4, $5)
     on conflict (idempotency_key) do nothing`,
    [who.workspaceId, who.userId, micro, extra.key ?? null, extra.costUsd ?? micro / 1_000_000],
  );

const counter = async (subject: string, period = "total") =>
  (
    await db.query<{ spent_micro: string; reserved_micro: string }>(
      "select spent_micro, reserved_micro from public.budget_counters where subject = $1 and period = $2 and modality = 'all'",
      [subject, period],
    )
  ).rows[0];

const setPlan = async (userId: string, plan: string, endsAt: string | null = null) => {
  await db.query("delete from public.account_plans where user_id = $1", [userId]);
  await db.query(
    "insert into public.account_plans (user_id, plan_key, ends_at) values ($1,$2,$3)",
    [userId, plan, endsAt],
  );
};

const person = async () => {
  const p = await createUser(db, `${key()}@example.com`);
  await setPlan(p.userId, "test_small");
  return p;
};

beforeAll(async () => {
  db = await createTestDatabase();
  a = await createUser(db, "a@example.com");
  b = await createUser(db, "b@example.com");
  await db.query(
    `insert into public.budget_plans (key, active, limits)
     values ('test_small', true, '{"total_micro": 1000}')`,
  );
  await db.query("update public.budget_plans set active = true where key = 'beta_90d'");
}, 60_000);

describe("the gate", () => {
  it("lets one of two simultaneous requests through when the balance covers only one", async () => {
    const p = await person();
    const [x, y] = await Promise.all([reserve(p, 700), reserve(p, 700)]);
    expect([x.allowed, y.allowed].sort()).toEqual([false, true]);
    const c = await counter(`user:${p.userId}`);
    expect(Number(c!.reserved_micro)).toBe(700);
  });

  it("answers a retry with the same decision and reserves once", async () => {
    const p = await person();
    const k = key();
    const first = await reserve(p, 400, { key: k });
    const again = await reserve(p, 400, { key: k });
    expect(again.reservation_id).toBe(first.reservation_id);
    expect(Number((await counter(`user:${p.userId}`))!.reserved_micro)).toBe(400);
  });

  it("never lets a closed reservation's key approve again", async () => {
    const p = await person();
    const k = key();
    const first = await reserve(p, 400, { key: k });
    await release(first.reservation_id);
    expect(await reserve(p, 400, { key: k })).toMatchObject({ allowed: false, reason: "key_used" });
    expect(Number((await counter(`user:${p.userId}`))!.reserved_micro)).toBe(0);
  });

  it("gives the amount back on release, once", async () => {
    const p = await person();
    const r = await reserve(p, 900);
    await release(r.reservation_id);
    await release(r.reservation_id);
    expect(Number((await counter(`user:${p.userId}`))!.reserved_micro)).toBe(0);
    expect((await reserve(p, 900)).allowed).toBe(true);
  });

  it("recovers what a crashed request left reserved", async () => {
    const p = await person();
    const r = await reserve(p, 900);
    await db.query(
      "update public.budget_reservations set expires_at = now() - interval '1 second' where id = $1",
      [r.reservation_id],
    );
    await db.query("select public.expire_budget_reservations()");
    expect(Number((await counter(`user:${p.userId}`))!.reserved_micro)).toBe(0);
  });

  it("counts what was spent, and stops at the limit", async () => {
    const p = await person();
    await record(p, 950);
    expect(await reserve(p, 100)).toMatchObject({ allowed: false, reason: "total_limit" });
    expect((await reserve(p, 50)).allowed).toBe(true);
  });

  it("keeps two people's balances apart", async () => {
    const x = await person();
    const y = await person();
    await record(x, 1000);
    expect((await reserve(x, 1)).allowed).toBe(false);
    expect((await reserve(y, 1000)).allowed).toBe(true);
  });

  it("refuses someone else's workspace, and an account with no plan", async () => {
    const p = await person();
    expect(await reserve({ userId: p.userId, workspaceId: a.workspaceId }, 1)).toMatchObject({
      allowed: false,
      reason: "not_a_member",
    });
    expect(await reserve(a, 1)).toMatchObject({ allowed: false, reason: "no_plan" });
  });

  it("makes a job without a person answer to the workspace's owner", async () => {
    const p = await person();
    await record({ userId: null, workspaceId: p.workspaceId }, 1000);
    expect(await reserve({ userId: null, workspaceId: p.workspaceId }, 1)).toMatchObject({
      allowed: false,
      reason: "total_limit",
    });
    expect(Number((await counter(`user:${p.userId}`))!.spent_micro)).toBe(1000);
  });

  it("in shadow says what it would have done, holds nothing and blocks nothing", async () => {
    const p = await person();
    await record(p, 1000);
    expect(await reserve(p, 500, { enforce: false })).toMatchObject({
      allowed: true,
      reason: "total_limit",
    });
    expect(Number((await counter(`user:${p.userId}`))!.reserved_micro)).toBe(0);
  });

  it("stops the whole beta when its pool runs out", async () => {
    await db.query("insert into public.budget_pools (key, limit_micro) values ('tiny', 100)");
    await db.query(
      "insert into public.budget_plans (key, active, pool_key) values ('pooled', true, 'tiny')",
    );
    const x = await createUser(db, "pool-x@example.com");
    const y = await createUser(db, "pool-y@example.com");
    await setPlan(x.userId, "pooled");
    await setPlan(y.userId, "pooled");
    await record(x, 100);
    expect(await reserve(y, 1)).toMatchObject({ allowed: false, reason: "pool_exhausted" });
  });

  it("has a limit per modality", async () => {
    await db.query(
      `insert into public.budget_plans (key, active, limits)
       values ('voice_small', true, '{"voice_day_micro": 10}')`,
    );
    const p = await createUser(db, "voice@example.com");
    await setPlan(p.userId, "voice_small");
    expect(await reserve(p, 11, { modality: "voice" })).toMatchObject({
      allowed: false,
      reason: "voice_day_limit",
    });
    expect((await reserve(p, 11, { modality: "chat" })).allowed).toBe(true);
  });
});

describe("the ledger", () => {
  it("doesn't count a replayed event twice", async () => {
    const p = await person();
    const k = key();
    await record(p, 300, { key: k });
    await record(p, 300, { key: k });
    expect(Number((await counter(`user:${p.userId}`))!.spent_micro)).toBe(300);
  });

  it("is immutable for the server too, and corrects with an adjustment", async () => {
    const p = await person();
    await record(p, 300);
    await db.exec("set role service_role");
    try {
      await expect(db.query("update public.usage_events set budget_micro = 0")).rejects.toThrow();
      await expect(db.query("delete from public.usage_events")).rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
    await db.query(
      `insert into public.usage_events (workspace_id, user_id, feature, operation, provider, budget_micro)
       values ($1, $2, 'chat', 'adjustment', 'openai', -100)`,
      [p.workspaceId, p.userId],
    );
    expect(Number((await counter(`user:${p.userId}`))!.spent_micro)).toBe(200);
  });

  it("keeps a recorded cost when prices change: it's stored, not recomputed", async () => {
    const p = await person();
    await record(p, 300, { costUsd: 0.0003 });
    await db.query("update public.budget_plans set limits = '{}' where key = 'test_small'");
    const row = await db.query<{ estimated_cost_usd: string; price_version: string }>(
      "select estimated_cost_usd, price_version from public.usage_events where user_id = $1",
      [p.userId],
    );
    expect(row.rows[0]).toMatchObject({ estimated_cost_usd: "0.000300", price_version: "v1" });
    await db.query(
      `update public.budget_plans set limits = '{"total_micro": 1000}' where key = 'test_small'`,
    );
  });

  it("still lets an account be deleted", async () => {
    const p = await person();
    await record(p, 10);
    await db.query("delete from auth.users where id = $1", [p.userId]);
    const left = await db.query("select 1 from public.usage_events where workspace_id = $1", [
      p.workspaceId,
    ]);
    expect(left.rows).toHaveLength(0);
  });
});

describe("what a signed-in person can reach", () => {
  const tables = [
    "budget_plans",
    "budget_pools",
    "account_plans",
    "beta_invitations",
    "budget_counters",
    "budget_reservations",
    "provider_invoices",
  ];

  it("can't read or write any budget table", async () => {
    for (const t of tables)
      await asUser(db, a.userId, async () => {
        await expect(db.query(`select * from public.${t}`)).rejects.toThrow();
        await expect(db.query(`delete from public.${t}`)).rejects.toThrow();
      });
  });

  it("can't give themselves a plan, a balance or a cost", async () => {
    await asUser(db, a.userId, async () => {
      await expect(
        db.query("insert into public.account_plans (user_id, plan_key) values ($1, 'internal')", [
          a.userId,
        ]),
      ).rejects.toThrow();
      await expect(
        db.query(
          `insert into public.usage_events (workspace_id, feature, operation, provider, budget_micro)
           values ($1, 'chat', 'llm', 'x', -1000000)`,
          [a.workspaceId],
        ),
      ).rejects.toThrow();
      await expect(
        db.query("update public.usage_events set estimated_cost_usd = 0"),
      ).rejects.toThrow();
    });
  });

  it("can't call the gate or the balance functions", async () => {
    const calls = [
      "select public.reserve_budget('x', null, null, 'chat', 0, false)",
      "select public.release_budget(gen_random_uuid())",
      "select public.budget_bump('user:x', 'total', 'all', -5, 0)",
      "select public.budget_status(gen_random_uuid())",
      "select public.activate_beta(gen_random_uuid(), 'x', 'y')",
      "select public.usage_cost_report(now())",
    ];
    for (const sql of calls)
      await asUser(db, b.userId, async () => {
        await expect(db.query(sql)).rejects.toThrow();
      });
  });

  it("doesn't leave the server a way to edit balances directly either", async () => {
    await db.exec("set role service_role");
    try {
      await expect(db.query("update public.budget_counters set spent_micro = 0")).rejects.toThrow();
      await expect(
        db.query("select public.budget_bump('user:x', 'total', 'all', -5, 0)"),
      ).rejects.toThrow();
    } finally {
      await db.exec("reset role");
    }
  });

  it("sees only another workspace's nothing in usage_events", async () => {
    const mine = await person();
    await record(mine, 1);
    await asUser(db, b.userId, async () => {
      const rows = await db.query("select 1 from public.usage_events where workspace_id = $1", [
        mine.workspaceId,
      ]);
      expect(rows.rows).toHaveLength(0);
    });
  });
});

describe("the 90-day beta", () => {
  const invite = async () => {
    const code = `code-${key()}-${key()}`;
    await db.query("insert into public.beta_invitations (code_hash) values ($1)", [code]);
    return code;
  };
  const activate = async (user: string, code: string, identity = `id-${key()}-${key()}`) =>
    (
      await db.query<{ activate_beta: string }>("select public.activate_beta($1, $2, $3)", [
        user,
        code,
        identity,
      ])
    ).rows[0]!.activate_beta;

  it("starts at activation, not at sign-up, and lasts 90 days", async () => {
    const p = await createUser(db, "trial@example.com");
    await db.query("update auth.users set email = email where id = $1", [p.userId]);
    expect(await activate(p.userId, await invite())).toBe("activated");
    const row = await db.query<{ days: number }>(
      "select extract(day from ends_at - started_at)::int as days from public.account_plans where user_id = $1",
      [p.userId],
    );
    expect(row.rows[0]!.days).toBe(90);
  });

  it("blocks when it ends, keeps the data and renews nothing", async () => {
    const p = await createUser(db, "ended@example.com");
    await activate(p.userId, await invite());
    await db.query(
      "update public.account_plans set ends_at = now() - interval '1 minute' where user_id = $1",
      [p.userId],
    );
    expect(await reserve(p, 1)).toMatchObject({ allowed: false, reason: "trial_expired" });
    expect(await activate(p.userId, await invite())).toBe("has_plan");
    const plan = await db.query("select 1 from public.account_plans where user_id = $1", [
      p.userId,
    ]);
    expect(plan.rows).toHaveLength(1);
  });

  it("gives one trial per invitation and per identity, even after deleting the account", async () => {
    const identity = `same-person-${key()}-${key()}`;
    const first = await createUser(db, "once@example.com");
    const code = await invite();
    expect(await activate(first.userId, code, identity)).toBe("activated");
    const other = await createUser(db, "twice@example.com");
    expect(await activate(other.userId, code)).toBe("used");
    await db.query("delete from auth.users where id = $1", [first.userId]);
    expect(await activate(other.userId, await invite(), identity)).toBe("already_tried");
  });

  it("stays closed while its plan is inactive, and respects the seats", async () => {
    const p = await createUser(db, "closed@example.com");
    await db.query("update public.budget_plans set active = false where key = 'beta_90d'");
    expect(await activate(p.userId, await invite())).toBe("closed");
    await db.query("update public.budget_plans set active = true where key = 'beta_90d'");
    await db.query("update public.budget_pools set seats = 0 where key = 'beta'");
    expect(await activate(p.userId, await invite())).toBe("full");
    await db.query("update public.budget_pools set seats = 30 where key = 'beta'");
  });

  it("ships with every commercial plan off", async () => {
    const fresh = await createTestDatabase();
    const plans = await fresh.query<{ key: string; active: boolean }>(
      "select key, active from public.budget_plans order by key",
    );
    expect(plans.rows.filter((p) => p.active).map((p) => p.key)).toEqual(["internal"]);
    await fresh.close();
  }, 60_000);
});

describe("the status and the report", () => {
  it("tells a percentage, never an amount", async () => {
    const p = await person();
    await record(p, 750);
    const row = await db.query<Record<string, unknown>>("select * from public.budget_status($1)", [
      p.userId,
    ]);
    expect(row.rows[0]).toMatchObject({ plan_key: "test_small", used_percent: 75 });
    expect(Object.keys(row.rows[0]!).sort()).toEqual(["ends_at", "plan_key", "used_percent"]);
  });

  it("aggregates without identities", async () => {
    const report = await db.query<{ usage_cost_report: Record<string, unknown> }>(
      "select public.usage_cost_report(now() - interval '1 day')",
    );
    const r = report.rows[0]!.usage_cost_report;
    expect(r).toHaveProperty("perAccount");
    expect(JSON.stringify(r)).not.toContain(a.userId);
    expect(JSON.stringify(r)).not.toContain("@example.com");
  });
});
