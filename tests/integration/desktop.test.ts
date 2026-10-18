import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser } from "./db-harness";

/**
 * ELISE Desktop RLS (ADR-081), against the real migrations: each person sees and maintains only
 * their own installations, and nobody reads sign-in codes from the client.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
const INSTALL = "33333333-3333-4333-8333-333333333333";

const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));

beforeAll(async () => {
  db = await createTestDatabase();
  alice = await createUser(db, "alice-desktop@example.com");
  bob = await createUser(db, "bob-desktop@example.com");
});

describe("desktop installations", () => {
  it("a person registers and updates their own installation", async () => {
    await as(
      alice,
      `insert into public.desktop_installations (user_id, workspace_id, installation_id, platform, capabilities)
       values ($1, $2, $3, 'windows', '{home_hub}')`,
      [alice.userId, alice.workspaceId, INSTALL],
    );
    await as(
      alice,
      "update public.desktop_installations set last_seen_at = now() where installation_id = $1",
      [INSTALL],
    );
    const mine = await as(alice, "select installation_id from public.desktop_installations");
    expect(mine.rows).toHaveLength(1);
  });

  it("nobody else sees, changes or impersonates it", async () => {
    expect((await as(bob, "select * from public.desktop_installations")).rows).toHaveLength(0);
    const upd = await as(
      bob,
      "update public.desktop_installations set name = 'mine now' where installation_id = $1 returning id",
      [INSTALL],
    );
    expect(upd.rows).toHaveLength(0);
    await expect(
      as(
        bob,
        `insert into public.desktop_installations (user_id, workspace_id, installation_id, platform)
         values ($1, $2, gen_random_uuid(), 'windows')`,
        [alice.userId, alice.workspaceId],
      ),
    ).rejects.toThrow();
    // Not even into a workspace they don't belong to, as themselves.
    await expect(
      as(
        bob,
        `insert into public.desktop_installations (user_id, workspace_id, installation_id, platform)
         values ($1, $2, gen_random_uuid(), 'windows')`,
        [bob.userId, alice.workspaceId],
      ),
    ).rejects.toThrow();
  });
});

describe("desktop sign-in codes", () => {
  it("are server-only: no client reads or writes them", async () => {
    await db.query(
      `insert into public.desktop_auth_codes (code_hash, challenge, user_id, workspace_id, installation_id, expires_at)
       values ('h', $1, $2, $3, $4, now() + interval '5 minutes')`,
      ["c".repeat(43), alice.userId, alice.workspaceId, INSTALL],
    );
    await expect(as(alice, "select * from public.desktop_auth_codes")).rejects.toThrow();
    await expect(
      as(
        alice,
        `insert into public.desktop_auth_codes (code_hash, challenge, user_id, workspace_id, installation_id, expires_at)
         values ('x', $1, $2, $3, $4, now())`,
        ["c".repeat(43), alice.userId, alice.workspaceId, INSTALL],
      ),
    ).rejects.toThrow();
  });
});
