import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser } from "./db-harness";

/**
 * Note tags (ADR-088, migration 054) on a real Postgres: names unique per workspace (any
 * casing), colors from the palette only, links scoped to the workspace, and deleting a tag
 * keeps every note.
 */
let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };

const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));
const id = async (u: { userId: string }, sql: string, args: unknown[] = []) =>
  (await as<{ id: string }>(u, sql, args)).rows[0]!.id;
const note = (u: typeof alice, title: string) =>
  id(u, "insert into public.notes (workspace_id, title) values ($1, $2) returning id", [
    u.workspaceId,
    title,
  ]);
const tag = (u: typeof alice, name: string, color = "blue") =>
  id(
    u,
    "insert into public.note_tags (workspace_id, name, color) values ($1, $2, $3) returning id",
    [u.workspaceId, name, color],
  );
const link = (u: typeof alice, noteId: string, tagId: string) =>
  as(u, "insert into public.note_tag_links (workspace_id, note_id, tag_id) values ($1, $2, $3)", [
    u.workspaceId,
    noteId,
    tagId,
  ]);

beforeAll(async () => {
  db = await createTestDatabase();
  alice = await createUser(db, "alice-tags@example.com");
  bob = await createUser(db, "bob-tags@example.com");
}, 120_000);

describe("note tags", () => {
  it("one name per workspace, whatever the casing; another workspace may reuse it", async () => {
    await tag(alice, "Ideas");
    await expect(tag(alice, "  ideas ")).rejects.toThrow(/duplicate|unique/i);
    await expect(tag(bob, "Ideas")).resolves.toBeTruthy();
  });

  it("colors come from the palette only", async () => {
    await expect(tag(alice, "Rara", "#ff0000")).rejects.toThrow(/check/i);
  });

  it("a note carries several tags; deleting a tag keeps the note", async () => {
    const n = await note(alice, "Plan Q4");
    const urgent = await tag(alice, "Urgente", "red");
    const work = await tag(alice, "Trabajo", "teal");
    await link(alice, n, urgent);
    await link(alice, n, work);
    await as(alice, "delete from public.note_tags where id = $1", [urgent]);
    const left = await as<{ tag_id: string }>(
      alice,
      "select tag_id from public.note_tag_links where note_id = $1",
      [n],
    );
    expect(left.rows.map((r) => r.tag_id)).toEqual([work]);
    const still = await as<{ title: string }>(
      alice,
      "select title from public.notes where id = $1",
      [n],
    );
    expect(still.rows[0]?.title).toBe("Plan Q4");
  });

  it("nothing crosses workspaces: no linking another's tag, no reading another's tags", async () => {
    const mine = await note(alice, "Mía");
    const bobs = await tag(bob, "Secreto");
    await expect(link(alice, mine, bobs)).rejects.toThrow();
    const seen = await as<{ name: string }>(alice, "select name from public.note_tags");
    expect(seen.rows.map((r) => r.name)).not.toContain("Secreto");
  });
});
