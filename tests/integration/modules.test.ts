import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser, migrateFrom } from "./db-harness";

/**
 * Mi ELISE (ADR-064, migration 047) on a real Postgres: existing users keep every module, the
 * backfill is idempotent, and nobody reads or changes someone else's choices.
 */

const MIGRATION = "20261028000047";

let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };

const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));

beforeAll(async () => {
  db = await createTestDatabase(MIGRATION);
  alice = await createUser(db, "alice@example.com");
  bob = await createUser(db, "bob@example.com");
  await as(alice, "insert into public.tasks (workspace_id, title) values ($1, 'Keep me')", [
    alice.workspaceId,
  ]);
  await migrateFrom(db, MIGRATION);
}, 120_000);

describe("migration 047", () => {
  it("keeps the six modules on for everyone who already used ELISE, without touching data", async () => {
    const rows = await as<{ module_key: string; enabled: boolean }>(
      alice,
      "select module_key, enabled from public.user_module_preferences order by module_key",
    );
    expect(rows.rows.map((r) => [r.module_key, r.enabled])).toEqual(
      ["finance", "goals", "habits", "lists", "notes", "tasks"].map((k) => [k, true]),
    );
    const tasks = await as(alice, "select title from public.tasks");
    expect(tasks.rows).toEqual([{ title: "Keep me" }]);
  });

  it("is idempotent: running it again keeps a choice made since", async () => {
    await as(
      alice,
      "update public.user_module_preferences set enabled = false where module_key = 'finance'",
    );
    await migrateFrom(db, MIGRATION);
    const finance = await as<{ enabled: boolean }>(
      alice,
      "select enabled from public.user_module_preferences where module_key = 'finance'",
    );
    expect(finance.rows).toEqual([{ enabled: false }]);
  });

  it("each person sees and changes only their own choices", async () => {
    const seen = await as<{ user_id: string }>(
      bob,
      "select distinct user_id from public.user_module_preferences",
    );
    expect(seen.rows).toEqual([{ user_id: bob.userId }]);
    const changed = await as(
      bob,
      "update public.user_module_preferences set enabled = false where user_id = $1",
      [alice.userId],
    );
    expect(changed.affectedRows).toBe(0);
    await expect(
      as(
        bob,
        "insert into public.user_module_preferences (workspace_id, user_id, module_key, enabled) values ($1, $2, 'habits', false)",
        [alice.workspaceId, alice.userId],
      ),
    ).rejects.toThrow();
    await expect(
      as(
        bob,
        "insert into public.user_module_preferences (workspace_id, user_id, module_key, enabled) values ($1, $2, 'x; drop', true)",
        [bob.workspaceId, bob.userId],
      ),
    ).rejects.toThrow();
  });
});
