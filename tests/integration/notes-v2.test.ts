import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { asUser, createTestDatabase, createUser, migrateFrom } from "./db-harness";

/**
 * Notes v2 (ADR-056, migration 043) on a real Postgres: one note in many Spaces, memberships
 * unique and workspace-scoped, existing notes migrated, retrieval through membership with each
 * chunk returned once.
 */

const MIGRATION = "20261024000043";

let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };
let legacyNote: string;
let solutions: string;

const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
  asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));
const one = async (u: { userId: string }, sql: string, args: unknown[] = []) =>
  (await as<{ id: string }>(u, sql, args)).rows[0]!.id;
const space = (u: { userId: string; workspaceId: string }, name: string) =>
  one(
    u,
    "insert into public.knowledge_spaces (workspace_id, name, created_by_user_id) values ($1, $2, $3) returning id",
    [u.workspaceId, name, u.userId],
  );

beforeAll(async () => {
  // A database as production has it before 043, with a note filed in one Space.
  db = await createTestDatabase(MIGRATION);
  alice = await createUser(db, "alice@example.com");
  bob = await createUser(db, "bob@example.com");
  solutions = await space(alice, "Firbot Solutions");
  legacyNote = await one(
    alice,
    "insert into public.notes (workspace_id, title, content, space_id) values ($1, 'Proceso comercial', 'Texto plano de antes', $2) returning id",
    [alice.workspaceId, solutions],
  );
  await migrateFrom(db, MIGRATION);
}, 120_000);

describe("migration 043", () => {
  it("keeps existing notes and their Space as a membership", async () => {
    const note = await as<{ content: string; space_id: string }>(
      alice,
      "select content, space_id from public.notes where id = $1",
      [legacyNote],
    );
    expect(note.rows[0]).toEqual({ content: "Texto plano de antes", space_id: solutions });
    const members = await as<{ space_id: string }>(
      alice,
      "select space_id from public.note_knowledge_spaces where note_id = $1",
      [legacyNote],
    );
    expect(members.rows).toEqual([{ space_id: solutions }]);
  });
});

describe("note ↔ Space membership", () => {
  it("links one note to several Spaces, never twice to the same one", async () => {
    const marketing = await space(alice, "Firbot Marketing");
    const general = (
      await as<{ id: string }>(
        alice,
        "select id from public.knowledge_spaces where kind = 'general'",
      )
    ).rows[0]!.id;
    const add = (spaceId: string) =>
      as(
        alice,
        "insert into public.note_knowledge_spaces (workspace_id, note_id, space_id) values ($1, $2, $3)",
        [alice.workspaceId, legacyNote, spaceId],
      );
    await add(marketing);
    await add(general);
    await expect(add(marketing)).rejects.toThrow(/duplicate key/);
    const rows = await as(alice, "select id from public.note_knowledge_spaces where note_id = $1", [
      legacyNote,
    ]);
    expect(rows.rows).toHaveLength(3);
    // Still one note.
    expect((await as(alice, "select id from public.notes")).rows).toHaveLength(1);
    // Removing a membership keeps the note.
    await as(
      alice,
      "delete from public.note_knowledge_spaces where note_id = $1 and space_id = $2",
      [legacyNote, marketing],
    );
    expect(
      (await as(alice, "select id from public.notes where id = $1", [legacyNote])).rows,
    ).toHaveLength(1);
  });

  it("never attaches a note to another workspace's Space, nor shows it to them", async () => {
    const bobSpace = await space(bob, "Bob");
    await expect(
      as(
        alice,
        "insert into public.note_knowledge_spaces (workspace_id, note_id, space_id) values ($1, $2, $3)",
        [alice.workspaceId, legacyNote, bobSpace],
      ),
    ).rejects.toThrow(/same workspace/);
    await expect(
      as(
        bob,
        "insert into public.note_knowledge_spaces (workspace_id, note_id, space_id) values ($1, $2, $3)",
        [bob.workspaceId, legacyNote, bobSpace],
      ),
    ).rejects.toThrow(/same workspace/);
    expect((await as(bob, "select id from public.note_knowledge_spaces")).rows).toHaveLength(0);
    // Item memberships are written by ELISE's indexing only.
    await expect(
      as(
        alice,
        "insert into public.knowledge_item_spaces (workspace_id, knowledge_item_id, space_id) values ($1, gen_random_uuid(), $2)",
        [alice.workspaceId, solutions],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("retrieval through membership", () => {
  it("finds a note from every Space it belongs to, once — and not from a removed one", async () => {
    const a = await space(alice, "Space A");
    const b = await space(alice, "Space B");
    const c = await space(alice, "Space C");
    // Service-role writes, as the indexing runtime does: ONE item, ONE chunk, home Space A.
    const src = (
      await db.query<{ id: string }>(
        "insert into public.knowledge_sources (workspace_id, space_id, provider_key, source_type, display_name, status) values ($1, $2, 'elise_native', 'note', 'ELISE Notes', 'ready') returning id",
        [alice.workspaceId, a],
      )
    ).rows[0]!.id;
    const item = (
      await db.query<{ id: string }>(
        "insert into public.knowledge_items (workspace_id, space_id, source_id, item_type, external_id, title, status) values ($1, $2, $3, 'note', $4, 'Proceso comercial', 'ready') returning id",
        [alice.workspaceId, a, src, legacyNote],
      )
    ).rows[0]!.id;
    const version = (
      await db.query<{ id: string }>(
        "insert into public.knowledge_versions (workspace_id, knowledge_item_id, version_number, is_current, status) values ($1, $2, 1, true, 'ready') returning id",
        [alice.workspaceId, item],
      )
    ).rows[0]!.id;
    await db.query("update public.knowledge_items set current_version_id = $1 where id = $2", [
      version,
      item,
    ]);
    await db.query(
      "insert into public.knowledge_chunks (workspace_id, space_id, source_id, knowledge_item_id, version_id, chunk_index, content) values ($1, $2, $3, $4, $5, 0, 'propuesta comercial con pasos')",
      [alice.workspaceId, a, src, item, version],
    );
    for (const s of [a, b])
      await db.query(
        "insert into public.knowledge_item_spaces (workspace_id, knowledge_item_id, space_id) values ($1, $2, $3)",
        [alice.workspaceId, item, s],
      );
    const search = (spaces: string[]) =>
      as<{ knowledge_item_id: string }>(
        alice,
        "select knowledge_item_id from public.search_knowledge_chunks($1, 'propuesta & comercial', null, 'm', $2, null, 10)",
        [alice.workspaceId, spaces],
      );
    expect((await search([b])).rows).toEqual([{ knowledge_item_id: item }]);
    // Both Spaces in scope: still one result.
    expect((await search([a, b])).rows).toHaveLength(1);
    expect((await search([c])).rows).toHaveLength(0);
    // Removed from B: B no longer finds it.
    await db.query(
      "delete from public.knowledge_item_spaces where knowledge_item_id = $1 and space_id = $2",
      [item, b],
    );
    expect((await search([b])).rows).toHaveLength(0);
    expect((await search([a])).rows).toHaveLength(1);
    // Bob can't reach it at all.
    const bobSees = await as(
      bob,
      "select knowledge_item_id from public.search_knowledge_chunks($1, 'propuesta', null, 'm', null, null, 10)",
      [alice.workspaceId],
    );
    expect(bobSees.rows).toHaveLength(0);
  });
});
