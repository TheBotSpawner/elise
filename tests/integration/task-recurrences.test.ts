import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser } from "./db-harness";

/**
 * Recurring task series (ADR-115, migration 066) on a real Postgres: one active series per live
 * task, an atomic claim (two completions advance once), and no cross-workspace access.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };

const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));

const connectionOf = async (u: typeof alice) =>
  (
    await db.query<{ id: string }>(
      "select id from public.provider_connections where workspace_id = $1 limit 1",
      [u.workspaceId],
    )
  ).rows[0]!.id;

const series = (u: typeof alice, connection: string, taskId: string) =>
  as<{ id: string }>(
    u,
    `insert into public.task_recurrences
       (workspace_id, created_by, provider_key, connection_id, current_task_id, rrule, dtstart,
        occurrence_date, timezone)
     values ($1, $2, 'elise_native', $3, $4, 'FREQ=WEEKLY;BYDAY=MO', '2026-10-26', '2026-10-26',
        'America/Argentina/Buenos_Aires')
     returning id`,
    [u.workspaceId, u.userId, connection, taskId],
  );

const claim = (u: typeof alice, id: string, from: string) =>
  as<{ id: string }>(
    u,
    `update public.task_recurrences
        set current_task_id = 'pending:2026-11-02', occurrence_date = '2026-11-02',
            occurrences = occurrences + 1
      where id = $1 and status = 'active' and current_task_id = $2
      returning id`,
    [id, from],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  alice = await createUser(db, "alice-recur@example.com");
  bob = await createUser(db, "bob-recur@example.com");
}, 120_000);

describe("task recurrences", () => {
  it("one active series per live task", async () => {
    const c = await connectionOf(alice);
    await series(alice, c, "task-1");
    await expect(series(alice, c, "task-1")).rejects.toThrow(/duplicate|unique/i);
  });

  it("two completions of the same occurrence advance it once", async () => {
    const c = await connectionOf(alice);
    const { id } = (await series(alice, c, "task-2")).rows[0]!;
    expect((await claim(alice, id, "task-2")).rows).toHaveLength(1);
    expect((await claim(alice, id, "task-2")).rows).toHaveLength(0);
    const row = await as<{ occurrences: number; occurrence_date: string }>(
      alice,
      "select occurrences, occurrence_date::text from public.task_recurrences where id = $1",
      [id],
    );
    expect(row.rows[0]).toMatchObject({ occurrences: 2, occurrence_date: "2026-11-02" });
  });

  it("nothing crosses workspaces", async () => {
    const aliceConnection = await connectionOf(alice);
    // Bob can't attach a series to Alice's connection, nor see Alice's.
    await expect(series(bob, aliceConnection, "x")).rejects.toThrow();
    const seen = await as<{ id: string }>(bob, "select id from public.task_recurrences");
    expect(seen.rows).toHaveLength(0);
  });

  it("the migration can be applied twice", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/20261117000066_task_recurrences.sql", "utf8");
    await expect(db.exec(sql)).resolves.toBeTruthy();
  });
});
