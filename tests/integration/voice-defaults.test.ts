import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, createUser, migrateFrom } from "./db-harness";

/**
 * ADR-104 (migration 061): continuous conversation starts off for new accounts; a value already
 * stored — an explicit "on" included — is never rewritten.
 */
let db: PGlite;
let before: { userId: string };

const continuous = async (userId: string) =>
  (
    await db.query<{ voice_continuous: boolean }>(
      "select voice_continuous from public.user_profiles where id = $1",
      [userId],
    )
  ).rows[0]!.voice_continuous;

beforeAll(async () => {
  db = await createTestDatabase("20261112000061");
  before = await createUser(db, "before-voice@example.com");
  // Someone who turned it on explicitly before the change.
  await db.query("update public.user_profiles set voice_continuous = true where id = $1", [
    before.userId,
  ]);
  await migrateFrom(db, "20261112000061");
}, 60_000);

describe("voice_continuous default", () => {
  it("a new account starts with continuous conversation off", async () => {
    const fresh = await createUser(db, "new-voice@example.com");
    expect(await continuous(fresh.userId)).toBe(false);
  });

  it("a stored choice is kept", async () => {
    expect(await continuous(before.userId)).toBe(true);
  });
});
