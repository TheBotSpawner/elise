import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser } from "./db-harness";

/**
 * ELISE Home RLS (ADR-079), against the real migrations: one workspace never sees or commands
 * another's home, and nobody reads hub credentials or pairing codes from the client.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
let home: string;
let hub: string;
let device: string;

const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));

beforeAll(async () => {
  db = await createTestDatabase();
  alice = await createUser(db, "alice-home@example.com");
  bob = await createUser(db, "bob-home@example.com");
  home = (
    await as<{ id: string }>(
      alice,
      "insert into public.homes (workspace_id, name) values ($1, 'Casa') returning id",
      [alice.workspaceId],
    )
  ).rows[0]!.id;
  // Hubs, credentials and devices are written by the server (service role).
  hub = (
    await db.query<{ id: string }>(
      "insert into public.home_hubs (workspace_id, home_id, token_prefix) values ($1, $2, 'ehh_abcd') returning id",
      [alice.workspaceId, home],
    )
  ).rows[0]!.id;
  await db.query(
    "insert into public.home_hub_credentials (hub_id, token_hash) values ($1, 'hash')",
    [hub],
  );
  await db.query(
    "insert into public.home_pairing_codes (workspace_id, home_id, code_hash, expires_at) values ($1, $2, 'codehash', now() + interval '10 minutes')",
    [alice.workspaceId, home],
  );
  device = (
    await db.query<{ id: string }>(
      "insert into public.home_devices (workspace_id, home_id, hub_id, provider_key, name, device_type, state) values ($1, $2, $3, 'dev_lamp', 'Luz escritorio', 'light', '{\"on\": true}') returning id",
      [alice.workspaceId, home, hub],
    )
  ).rows[0]!.id;
}, 60_000);

describe("ELISE Home isolation", () => {
  it("the owner sees her home, hub and devices", async () => {
    expect((await as(alice, "select id from public.home_devices")).rows).toHaveLength(1);
    expect((await as(alice, "select id, name from public.home_hubs")).rows).toHaveLength(1);
  });

  it("another workspace sees none of it: names, state, rooms, hub", async () => {
    for (const table of [
      "homes",
      "home_hubs",
      "home_devices",
      "home_rooms",
      "home_scenes",
      "home_commands",
    ])
      expect((await as(bob, `select * from public.${table}`)).rows, table).toHaveLength(0);
  });

  it("another workspace can't send a command to her hub", async () => {
    await expect(
      as(
        bob,
        "insert into public.home_commands (workspace_id, home_id, hub_id, device_id, actions, expires_at) values ($1, $2, $3, $4, '[]', now())",
        [alice.workspaceId, home, hub, device],
      ),
    ).rejects.toThrow();
  });

  it("the owner can queue a command, but can't mark it done (only the hub, via the server)", async () => {
    const cmd = (
      await as<{ id: string }>(
        alice,
        'insert into public.home_commands (workspace_id, home_id, hub_id, device_id, actions, expires_at) values ($1, $2, $3, $4, \'[{"type":"power","on":true}]\', now() + interval \'30 seconds\') returning id',
        [alice.workspaceId, home, hub, device],
      )
    ).rows[0]!.id;
    await as(alice, "update public.home_commands set status = 'succeeded' where id = $1", [cmd]);
    const row = (
      await db.query<{ status: string }>("select status from public.home_commands where id = $1", [
        cmd,
      ])
    ).rows[0]!;
    expect(row.status).toBe("queued");
    await expect(
      as(
        alice,
        "insert into public.home_commands (workspace_id, home_id, hub_id, device_id, actions, expires_at, status) values ($1, $2, $3, $4, '[]', now(), 'succeeded')",
        [alice.workspaceId, home, hub, device],
      ),
    ).rejects.toThrow();
  });

  it("hub credentials and pairing codes are server-only", async () => {
    expect((await as(alice, "select * from public.home_hub_credentials")).rows).toHaveLength(0);
    expect((await as(alice, "select * from public.home_pairing_codes")).rows).toHaveLength(0);
  });
});
