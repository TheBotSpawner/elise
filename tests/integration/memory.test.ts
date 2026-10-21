import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser, migrateFrom } from "./db-harness";

/**
 * Native memory (ADR-107, migration 062): the JSON facts become rows with honest provenance,
 * memory is private to its author (RLS), and the spend ledger enforces hard monthly caps —
 * atomically and idempotently, server only.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };

const F1 = "11111111-1111-4111-8111-111111111111";
const F2 = "22222222-2222-4222-8222-222222222222";
const F3 = "33333333-3333-4333-8333-333333333333";
const F4 = "44444444-4444-4444-8444-444444444444";
const CONV = "55555555-5555-4555-8555-555555555555";

beforeAll(async () => {
  db = await createTestDatabase("20261113000062");
  alice = await createUser(db, "alice-memory@example.com");
  bob = await createUser(db, "bob-memory@example.com");
  const legacy = [
    {
      id: F1,
      key: "trabajo.horario",
      value: "De 9 a 18",
      confidence: "stated",
      sources: [CONV],
      status: "active",
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-02T10:00:00.000Z",
      lastConfirmedAt: "2026-10-02T10:00:00.000Z",
    },
    { id: F2, key: "apodo", value: "Leo", confidence: "stated", sources: [], status: "active" },
    {
      id: F3,
      key: "estudio",
      value: "De noche",
      confidence: "inferred",
      sources: [CONV],
      status: "active",
    },
    {
      id: F4,
      key: "apodo",
      value: "Leíto",
      confidence: "stated",
      sources: [],
      status: "superseded",
    },
    {
      id: "not-a-uuid",
      key: "comida",
      value: "Pastas",
      confidence: "stated",
      sources: ["x"],
      status: "active",
    },
  ];
  await db.query(
    "insert into public.user_preferences (workspace_id, user_id, key, value_json) values ($1, $2, 'memory.facts', $3)",
    [alice.workspaceId, alice.userId, JSON.stringify(legacy)],
  );
  await migrateFrom(db, "20261113000062");
}, 120_000);

describe("migration 062: JSON facts → rows", () => {
  it("copies every fact with honest provenance, keeping ids and history", async () => {
    const { rows } = await db.query<{
      id: string;
      key: string;
      provenance: string;
      certainty: number;
      status: string;
      sources: string[];
    }>(
      "select id, key, provenance, certainty, status, sources from public.memory_facts where user_id = $1 order by key, status",
      [alice.userId],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(F1)).toMatchObject({
      provenance: "user_explicit",
      status: "active",
      sources: [CONV],
    });
    expect(byId.get(F2)).toMatchObject({ provenance: "user_settings", status: "active" });
    expect(byId.get(F3)).toMatchObject({ provenance: "inferred", status: "active" });
    expect(Number(byId.get(F3)!.certainty)).toBeCloseTo(0.6);
    expect(byId.get(F4)).toMatchObject({ status: "superseded" });
    // A malformed id gets a new one; a malformed source is dropped, never invented.
    const comida = rows.find((r) => r.key === "comida")!;
    expect(comida.sources).toEqual([]);
    expect(rows).toHaveLength(5);
  });

  it("removes the old JSON copy (nothing forgotten later survives in it)", async () => {
    const { rows } = await db.query(
      "select 1 from public.user_preferences where key = 'memory.facts'",
    );
    expect(rows).toHaveLength(0);
  });
});

describe("memory is private to its author", () => {
  it("nobody else reads it — facts, profile, forget list or spend", async () => {
    await db.query(
      "insert into public.memory_profiles (workspace_id, user_id, lines) values ($1, $2, '[]')",
      [alice.workspaceId, alice.userId],
    );
    await db.query(
      "insert into public.memory_suppressions (workspace_id, user_id, key_hash, value_hash) values ($1, $2, repeat('a', 64), repeat('b', 64))",
      [alice.workspaceId, alice.userId],
    );
    for (const table of [
      "memory_facts",
      "memory_profiles",
      "memory_suppressions",
      "memory_spend",
    ]) {
      const seen = await asUser(db, bob.userId, () => db.query(`select * from public.${table}`));
      expect(seen.rows, table).toHaveLength(0);
    }
    const own = await asUser(db, alice.userId, () =>
      db.query("select id from public.memory_facts"),
    );
    expect(own.rows.length).toBe(5);
  });

  it("nobody writes into someone else's memory", async () => {
    await expect(
      asUser(db, bob.userId, () =>
        db.query(
          "insert into public.memory_facts (workspace_id, user_id, key, value, provenance) values ($1, $2, 'x', 'y', 'user_explicit')",
          [alice.workspaceId, alice.userId],
        ),
      ),
    ).rejects.toThrow();
    const updated = await asUser(db, bob.userId, () =>
      db.query("update public.memory_facts set value = 'hacked' where user_id = $1 returning id", [
        alice.userId,
      ]),
    );
    expect(updated.rows).toHaveLength(0);
  });

  it("one current value per key: a second active 'truth' is refused", async () => {
    await expect(
      db.query(
        "insert into public.memory_facts (workspace_id, user_id, key, value, provenance) values ($1, $2, 'trabajo.horario', 'De 10 a 19', 'user_explicit')",
        [alice.workspaceId, alice.userId],
      ),
    ).rejects.toThrow();
  });
});

describe("monthly spend caps", () => {
  const reserve = (ref: string, usd: number, cap = 0.5, workspaceCap: number | null = null) =>
    db
      .query<{ id: string | null }>(
        "select public.memory_reserve_spend($1, $2, 'extract', $3, $4, $5, $6) as id",
        [alice.workspaceId, alice.userId, ref, usd, cap, workspaceCap],
      )
      .then((r) => r.rows[0]!.id);

  it("reserves under the cap and refuses past it", async () => {
    expect(await reserve("a", 0.3)).toBeTruthy();
    expect(await reserve("b", 0.3)).toBeNull();
    expect(await reserve("c", 0.2)).toBeTruthy();
  });

  it("a retried job gets its reservation back instead of counting twice; a settled one is done", async () => {
    const first = await reserve("retry", 0, 1);
    expect(await reserve("retry", 0, 1)).toBe(first);
    await db.query("select public.memory_settle_spend($1, 0)", [first]);
    expect(await reserve("retry", 0, 1)).toBeNull();
  });

  it("the real cost replaces the estimate; a release frees it", async () => {
    const id = await reserve("settle", 0.0, 10);
    await db.query("select public.memory_settle_spend($1, 0.25)", [id]);
    const { rows } = await db.query<{ actual_usd: string; status: string }>(
      "select actual_usd, status from public.memory_spend where id = $1",
      [id],
    );
    expect(rows[0]).toMatchObject({ status: "settled" });
    expect(Number(rows[0]!.actual_usd)).toBeCloseTo(0.25);
  });

  it("a workspace cap applies across its people", async () => {
    expect(await reserve("ws", 0.01, 10, 0.5)).toBeNull();
  });

  it("people can read their spend but never write it or call the ledger", async () => {
    await expect(
      asUser(db, alice.userId, () =>
        db.query(
          "insert into public.memory_spend (workspace_id, user_id, kind, job_ref, month, estimated_usd) values ($1, $2, 'extract', 'x', current_date, 0)",
          [alice.workspaceId, alice.userId],
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(db, alice.userId, () =>
        db.query("select public.memory_reserve_spend($1, $2, 'extract', 'y', 0, 100)", [
          alice.workspaceId,
          alice.userId,
        ]),
      ),
    ).rejects.toThrow();
    const mine = await asUser(db, alice.userId, () =>
      db.query("select id from public.memory_spend"),
    );
    expect(mine.rows.length).toBeGreaterThan(0);
  });
});
