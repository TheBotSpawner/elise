import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser } from "./db-harness";

/**
 * ADR-110 (migration 063): an infrared device can be created by a member only on an infrared
 * controller of their own workspace's hub — never on someone else's Broadlink.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
let home: string;
let hub: string;

const irDevice = (u: { userId: string; workspaceId: string }, key = "ir:x1") =>
  asUser(db, u.userId, () =>
    db.query(
      "insert into public.home_devices (workspace_id, home_id, hub_id, provider_key, name, device_type, added_at) values ($1, $2, $3, $4, 'TV', 'media_player', now()) returning id",
      [u.workspaceId, home, hub, key],
    ),
  );

beforeAll(async () => {
  db = await createTestDatabase();
  alice = await createUser(db, "alice-ir@example.com");
  bob = await createUser(db, "bob-ir@example.com");
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
      "insert into public.home_hubs (workspace_id, home_id, token_prefix) values ($1, $2, 'ehh_irir') returning id",
      [alice.workspaceId, home],
    )
  ).rows[0]!.id;
}, 60_000);

describe("home_devices: infrared", () => {
  it("needs a controller on that hub first", async () => {
    await expect(irDevice(alice)).rejects.toThrow();
    await db.query(
      "insert into public.home_devices (workspace_id, home_id, hub_id, provider_key, name, device_type) values ($1, $2, $3, 'bl1', 'Broadlink', 'ir_controller')",
      [alice.workspaceId, home, hub],
    );
    expect((await irDevice(alice)).rows).toHaveLength(1);
  });

  it("another person can't put one on it, and nobody can insert a non-infrared row", async () => {
    await expect(irDevice(bob, "ir:x2")).rejects.toThrow();
    await expect(irDevice(alice, "fake_wifi_device")).rejects.toThrow();
  });

  it("learned buttons fit (up to 16 kB of capabilities)", async () => {
    const caps = JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({ key: `custom_${i}`, label: "x".repeat(40) })),
    );
    await db.query(
      "update public.home_devices set capabilities = $1::jsonb where provider_key = 'ir:x1'",
      [caps],
    );
  });
});
