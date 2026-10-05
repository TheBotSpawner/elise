import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser } from "./db-harness";

/** Methods (ADR-040) at the database: versions, append-only history and tenancy, for real. */

let db: PGlite;
let ana: { userId: string; workspaceId: string };
let ben: { userId: string; workspaceId: string };
let space: string;
let section: string;

beforeAll(async () => {
  db = await createTestDatabase();
  ana = await createUser(db, "ana@example.com");
  ben = await createUser(db, "ben@example.com");
  const ins = (name: string, parent: string | null) =>
    asUser(db, ana.userId, () =>
      db.query<{ id: string }>(
        "insert into public.knowledge_spaces (workspace_id, name, parent_space_id, created_by_user_id) values ($1, $2, $3, $4) returning id",
        [ana.workspaceId, name, parent, ana.userId],
      ),
    );
  space = (await ins("Test Consulting", null)).rows[0]!.id;
  section = (await ins("Retail", space)).rows[0]!.id;
}, 60_000);

const create = (
  user: { userId: string; workspaceId: string },
  spaceId: string | null,
  name: string,
) =>
  asUser(db, user.userId, () =>
    db.query<{ id: string; version: number }>(
      `insert into public.methods (workspace_id, space_id, name, description, instructions, created_by_user_id, change_source)
       values ($1, $2, $3, 'What it is for', '1. Step one.', $4, 'ai_explicit') returning id, version`,
      [user.workspaceId, spaceId, name, user.userId],
    ),
  );

describe("methods", () => {
  it("global, Space and Section Methods are created at version 1 with their first snapshot", async () => {
    for (const [s, name] of [
      [null, "Global"],
      [space, "In the Space"],
      [section, "In the Section"],
    ] as const) {
      const { rows } = await create(ana, s, name);
      expect(rows[0]!.version).toBe(1);
      const v = await asUser(db, ana.userId, () =>
        db.query("select version, change_source from public.method_versions where method_id = $1", [
          rows[0]!.id,
        ]),
      );
      expect(v.rows).toEqual([{ version: 1, change_source: "ai_explicit" }]);
    }
  });

  it("every content change is a new version with its reason; status changes are not", async () => {
    const id = (await create(ana, space, "Proposal")).rows[0]!.id;
    await asUser(db, ana.userId, async () => {
      // A client can't pick the version number.
      await db.query(
        "update public.methods set instructions = '1. Impact first.', change_summary = 'Impact before details', change_source = 'ai_correction', version = 99 where id = $1",
        [id],
      );
      await db.query("update public.methods set status = 'archived' where id = $1", [id]);
      await db.query("update public.methods set status = 'active' where id = $1", [id]);
      await db.query("update public.methods set name = 'Proposal v3' where id = $1", [id]);
    });
    const m = await db.query<{ version: number; archived_at: string | null }>(
      "select version, archived_at from public.methods where id = $1",
      [id],
    );
    expect(m.rows[0]).toEqual({ version: 3, archived_at: null });
    const v = await db.query(
      "select version, change_summary, change_source, instructions from public.method_versions where method_id = $1 order by version",
      [id],
    );
    expect(v.rows).toEqual([
      expect.objectContaining({ version: 1, instructions: "1. Step one." }),
      expect.objectContaining({
        version: 2,
        change_summary: "Impact before details",
        change_source: "ai_correction",
        instructions: "1. Impact first.",
      }),
      // Same provenance fields as before: the trigger marks it a plain edit.
      expect.objectContaining({ version: 3, change_summary: "Edited" }),
    ]);
  });

  it("history is append-only and Methods are archived, never deleted, by API users", async () => {
    const id = (await create(ana, null, "Keep me")).rows[0]!.id;
    await expect(
      asUser(db, ana.userId, () =>
        db.query(
          "update public.method_versions set instructions = 'rewritten' where method_id = $1",
          [id],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, ana.userId, () =>
        db.query(
          "insert into public.method_versions (workspace_id, method_id, version, name, description, instructions, hints, platforms, change_summary, change_source, change_ref) values ($1, $2, 7, 'x', 'x', 'x', '{}', '{web}', 'x', 'user_ui', '{}')",
          [ana.workspaceId, id],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, ana.userId, () => db.query("delete from public.methods where id = $1", [id])),
    ).rejects.toThrow(/permission denied/);
  });

  it("another workspace sees nothing and can't attach a Method to someone else's Space", async () => {
    await create(ana, space, "Private");
    const seen = await asUser(db, ben.userId, () =>
      db.query("select id from public.methods union all select id from public.method_versions"),
    );
    expect(seen.rows).toHaveLength(0);
    const changed = await asUser(db, ben.userId, () =>
      db.query("update public.methods set instructions = 'hacked' where workspace_id = $1", [
        ana.workspaceId,
      ]),
    );
    expect(changed.affectedRows).toBe(0);
    await expect(create(ben, space, "Intrusion")).rejects.toThrow(/same workspace/);
    await expect(
      asUser(db, ben.userId, () =>
        db.query(
          "insert into public.methods (workspace_id, name, description, instructions, created_by_user_id) values ($1, 'x', 'x', 'x', $2)",
          [ana.workspaceId, ben.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("references belong to a Method of the same workspace; uses are private to their author", async () => {
    const id = (await create(ana, space, "With template")).rows[0]!.id;
    await asUser(db, ana.userId, () =>
      db.query(
        "insert into public.method_references (workspace_id, method_id, kind, title, content, source_type, created_by_user_id) values ($1, $2, 'template', 'Proposal template', 'PROBLEM / IMPACT / SOLUTION', 'text', $3)",
        [ana.workspaceId, id, ana.userId],
      ),
    );
    await expect(
      asUser(db, ben.userId, () =>
        db.query(
          "insert into public.method_references (workspace_id, method_id, kind, title, content, source_type, created_by_user_id) values ($1, $2, 'example', 'x', 'x', 'text', $3)",
          [ben.workspaceId, id, ben.userId],
        ),
      ),
    ).rejects.toThrow(/same workspace/);
    await asUser(db, ana.userId, () =>
      db.query(
        "insert into public.method_uses (workspace_id, user_id, method_id, method_version, scope, origin, reason, tools, status) values ($1, $2, $3, 1, 'space', 'chat', 'matched', '{knowledge.search}', 'completed')",
        [ana.workspaceId, ana.userId, id],
      ),
    );
    const uses = await asUser(db, ana.userId, () =>
      db.query("select method_version, tools from public.method_uses where method_id = $1", [id]),
    );
    expect(uses.rows).toEqual([{ method_version: 1, tools: ["knowledge.search"] }]);
    const bens = await asUser(db, ben.userId, () => db.query("select id from public.method_uses"));
    expect(bens.rows).toHaveLength(0);
  });

  it("only allowlisted platforms and sources", async () => {
    await expect(
      asUser(db, ana.userId, () =>
        db.query(
          "insert into public.methods (workspace_id, name, description, instructions, created_by_user_id, platforms) values ($1, 'x', 'x', 'x', $2, '{robot}')",
          [ana.workspaceId, ana.userId],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
