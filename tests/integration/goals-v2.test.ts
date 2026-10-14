import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser, migrateFrom } from "./db-harness";

/**
 * Goals v2 (ADR-055, migration 042) on a real Postgres: existing goals survive the migration,
 * Visions and progress history are workspace-scoped, links can't duplicate or loop.
 */

const MIGRATION = "20261023000042";

let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
let legacyGoal: string;

const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));
const one = async (u: { userId: string }, sql: string, args: unknown[] = []) =>
  (await as<{ id: string }>(u, sql, args)).rows[0]!.id;

beforeAll(async () => {
  // A database as production has it before 042, with real data in it.
  db = await createTestDatabase(MIGRATION);
  alice = await createUser(db, "alice@example.com");
  bob = await createUser(db, "bob@example.com");
  legacyGoal = await one(
    alice,
    "insert into public.goals (workspace_id, title, progress_type, current_value, target_value, metric) values ($1, 'Reach 100 clients', 'numeric', 40, 100, 'clients') returning id",
    [alice.workspaceId],
  );
  const habit = await one(
    alice,
    "insert into public.habits (workspace_id, name, frequency_type) values ($1, 'Old habit', 'weekly') returning id",
    [alice.workspaceId],
  );
  await as(
    alice,
    "insert into public.goal_links (workspace_id, goal_id, resource_type, resource_id) values ($1, $2, 'habit', $3)",
    [alice.workspaceId, legacyGoal, habit],
  );
  // Deleted under migration 040: its link was left dangling.
  await as(alice, "delete from public.habits where id = $1", [habit]);
  await migrateFrom(db, MIGRATION);
}, 120_000);

describe("migration 042", () => {
  it("keeps existing goals as goals, starts their history, and drops dangling links", async () => {
    const goal = await as<Record<string, unknown>>(
      alice,
      "select * from public.goals where id = $1",
      [legacyGoal],
    );
    expect(goal.rows[0]).toMatchObject({
      title: "Reach 100 clients",
      current_value: "40",
      target_value: "100",
      period_start: null,
      icon: null,
    });
    const events = await as<{ new_value: string; source_type: string }>(
      alice,
      "select new_value, source_type from public.goal_progress_events where goal_id = $1",
      [legacyGoal],
    );
    expect(events.rows).toEqual([{ new_value: "40", source_type: "system" }]);
    expect((await as(alice, "select id from public.visions")).rows).toHaveLength(0);
    expect(
      (await as(alice, "select id from public.goal_links where goal_id = $1", [legacyGoal])).rows,
    ).toHaveLength(0);
  });
});

describe("Visions and goal links", () => {
  it("scopes Visions to their workspace and links goals only to their own Visions", async () => {
    const vision = await one(
      alice,
      "insert into public.visions (workspace_id, title, icon) values ($1, 'Firbot Solutions es una agencia rentable', '🚀') returning id",
      [alice.workspaceId],
    );
    expect((await as(bob, "select id from public.visions")).rows).toHaveLength(0);
    await expect(
      as(bob, "insert into public.visions (workspace_id, title) values ($1, 'x')", [
        alice.workspaceId,
      ]),
    ).rejects.toThrow(/row-level security/);
    await as(
      alice,
      "insert into public.goal_links (workspace_id, goal_id, resource_type, resource_id) values ($1, $2, 'vision', $3)",
      [alice.workspaceId, legacyGoal, vision],
    );
    const bobGoal = await one(
      bob,
      "insert into public.goals (workspace_id, title) values ($1, 'Bob') returning id",
      [bob.workspaceId],
    );
    await expect(
      as(
        bob,
        "insert into public.goal_links (workspace_id, goal_id, resource_type, resource_id) values ($1, $2, 'vision', $3)",
        [bob.workspaceId, bobGoal, vision],
      ),
    ).rejects.toThrow(/same workspace/);
    // Deleting the Vision keeps the goal and removes only the link.
    await as(alice, "delete from public.visions where id = $1", [vision]);
    expect(
      (await as(alice, "select id from public.goals where id = $1", [legacyGoal])).rows,
    ).toHaveLength(1);
    expect(
      (await as(alice, "select id from public.goal_links where resource_type = 'vision'")).rows,
    ).toHaveLength(0);
  });

  it("stores a goal ↔ goal relation once and refuses circular parents", async () => {
    const a = await one(
      alice,
      "insert into public.goals (workspace_id, title) values ($1, 'A') returning id",
      [alice.workspaceId],
    );
    const b = await one(
      alice,
      "insert into public.goals (workspace_id, title, parent_goal_id) values ($1, 'B', $2) returning id",
      [alice.workspaceId, a],
    );
    const c = await one(
      alice,
      "insert into public.goals (workspace_id, title, parent_goal_id) values ($1, 'C', $2) returning id",
      [alice.workspaceId, b],
    );
    await expect(
      as(alice, "update public.goals set parent_goal_id = $1 where id = $2", [c, a]),
    ).rejects.toThrow(/circular/);
    const link = (g: string, r: string) =>
      as(
        alice,
        "insert into public.goal_links (workspace_id, goal_id, resource_type, resource_id, relationship_type) values ($1, $2, 'goal', $3, 'related')",
        [alice.workspaceId, g, r],
      );
    await link(a, c);
    await expect(link(a, c)).rejects.toThrow(/duplicate key/);
    await expect(link(c, a)).rejects.toThrow(/already related/);
  });

  it("keeps history append-only and deletes it with its goal", async () => {
    const g = await one(
      alice,
      "insert into public.goals (workspace_id, title) values ($1, 'Temp') returning id",
      [alice.workspaceId],
    );
    await as(
      alice,
      "insert into public.goal_progress_events (workspace_id, goal_id, previous_value, new_value, source_type, note) values ($1, $2, 0, 3, 'manual', 'first')",
      [alice.workspaceId, g],
    );
    await expect(
      as(alice, "update public.goal_progress_events set new_value = 9 where goal_id = $1", [g]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(alice, "delete from public.goal_progress_events where goal_id = $1", [g]),
    ).rejects.toThrow(/permission denied/);
    expect((await as(bob, "select id from public.goal_progress_events")).rows).toHaveLength(0);
    await expect(
      as(
        bob,
        "insert into public.goal_progress_events (workspace_id, goal_id, source_type) values ($1, $2, 'manual')",
        [bob.workspaceId, g],
      ),
    ).rejects.toThrow(/same workspace/);
    // Members may delete a goal for good: its history and links go with it.
    await as(alice, "delete from public.goals where id = $1", [g]);
    expect(
      (await db.query("select id from public.goal_progress_events where goal_id = $1", [g])).rows,
    ).toHaveLength(0);
    await expect(
      as(bob, "delete from public.goals where id = $1", [legacyGoal]),
    ).resolves.toBeDefined();
    expect(
      (await as(alice, "select id from public.goals where id = $1", [legacyGoal])).rows,
    ).toHaveLength(1);
  });

  it("rejects reversed periods", async () => {
    await expect(
      as(
        alice,
        "insert into public.goals (workspace_id, title, period_start, period_end) values ($1, 'Bad', '2026-12-01', '2026-10-01')",
        [alice.workspaceId],
      ),
    ).rejects.toThrow(/goals_period_order/);
  });
});
