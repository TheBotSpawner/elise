import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser, migrateFrom } from "./db-harness";

/**
 * ADR-103 (migration 060): devices already in Hogar stay the person's; a device the engine
 * registers afterwards is only found until the person adds it — and only they can.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
let home: string;
let hub: string;
let listed: string;

const insertDevice = async (key: string, name: string) =>
  (
    await db.query<{ id: string }>(
      "insert into public.home_devices (workspace_id, home_id, hub_id, provider_key, name, device_type) values ($1, $2, $3, $4, $5, 'media_player') returning id",
      [alice.workspaceId, home, hub, key, name],
    )
  ).rows[0]!.id;

beforeAll(async () => {
  db = await createTestDatabase("20261111000060");
  alice = await createUser(db, "alice-found@example.com");
  bob = await createUser(db, "bob-found@example.com");
  home = (
    await asUser(db, alice.userId, () =>
      db.query<{ id: string }>(
        "insert into public.homes (workspace_id, name) values ($1, 'Casa') returning id",
        [alice.workspaceId],
      ),
    )
  ).rows[0]!.id;
  hub = (
    await db.query<{ id: string }>(
      "insert into public.home_hubs (workspace_id, home_id, token_prefix) values ($1, $2, 'ehh_abcd') returning id",
      [alice.workspaceId, home],
    )
  ).rows[0]!.id;
  listed = await insertDevice("tv_living", "TV Living");
  await migrateFrom(db, "20261111000060");
}, 60_000);

describe("home_devices.added_at", () => {
  it("a device listed before the migration stays added", async () => {
    const r = await db.query<{ added_at: string | null }>(
      "select added_at from public.home_devices where id = $1",
      [listed],
    );
    expect(r.rows[0]!.added_at).not.toBeNull();
  });

  it("one the engine registers later (the hub's sync) is only found", async () => {
    const id = await insertDevice("cast_flowbox_f2", "FlowBox-F2");
    const r = await db.query<{ added_at: string | null }>(
      "select added_at from public.home_devices where id = $1",
      [id],
    );
    expect(r.rows[0]!.added_at).toBeNull();
  });

  it("only the owner can add it", async () => {
    const id = await insertDevice("cast_flowbox_z4", "FlowBox-Z4");
    const add = (u: { userId: string }) =>
      asUser(db, u.userId, () =>
        db.query("update public.home_devices set added_at = now() where id = $1 returning id", [
          id,
        ]),
      );
    expect((await add(bob)).rows).toHaveLength(0);
    expect((await add(alice)).rows).toHaveLength(1);
  });
});
