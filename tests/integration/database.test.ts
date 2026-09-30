import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { CAPABILITY_KEYS, getCapability } from "@/core/capabilities/registry";
import { PROVIDERS } from "@/core/providers/registry";

import { asUser, createTestDatabase, createUser } from "./db-harness";

let db: PGlite;
let alice: { userId: string; workspaceId: string };
let bob: { userId: string; workspaceId: string };

beforeAll(async () => {
  db = await createTestDatabase();
  alice = await createUser(db, "alice@example.com", {
    full_name: "Alice",
    preferred_language: "en",
    timezone: "America/Argentina/Buenos_Aires",
  });
  bob = await createUser(db, "bob@example.com", { timezone: "Not/AZone" });
}, 60_000);

describe("tenancy bootstrap", () => {
  it("creates a profile and an owned personal workspace for each new user", async () => {
    const profile = await db.query<{
      display_name: string;
      preferred_language: string;
      timezone: string;
    }>(
      "select display_name, preferred_language, timezone from public.user_profiles where id = $1",
      [alice.userId],
    );
    expect(profile.rows[0]).toEqual({
      display_name: "Alice",
      preferred_language: "en",
      timezone: "America/Argentina/Buenos_Aires",
    });
    const ws = await db.query<{ type: string; owner_user_id: string }>(
      "select type, owner_user_id from public.workspaces where id = $1",
      [alice.workspaceId],
    );
    expect(ws.rows[0]).toEqual({ type: "personal", owner_user_id: alice.userId });
    expect(alice.workspaceId).not.toBe(bob.workspaceId);
  });

  it("falls back to UTC for invalid timezones and to the email prefix for names", async () => {
    const profile = await db.query<{ display_name: string; timezone: string }>(
      "select display_name, timezone from public.user_profiles where id = $1",
      [bob.userId],
    );
    expect(profile.rows[0]).toEqual({ display_name: "bob", timezone: "UTC" });
  });

  it("provisions ELISE Native as the default provider of every native capability", async () => {
    const rows = await db.query<{
      provider_key: string;
      capability_key: string;
      is_default: boolean;
    }>(
      `select c.provider_key, b.capability_key, b.is_default
       from public.capability_bindings b join public.provider_connections c on c.id = b.connection_id
       where b.workspace_id = $1 order by b.capability_key`,
      [alice.workspaceId],
    );
    expect(rows.rows).toEqual(
      ["finance", "goals", "habits", "lists", "notes", "tasks"].map((capability_key) => ({
        provider_key: "elise_native",
        capability_key,
        is_default: true,
      })),
    );
  });
});

describe("catalog", () => {
  it("matches the code registries", async () => {
    const caps = await db.query<{ key: string }>(
      "select key from public.capability_definitions order by key",
    );
    expect(caps.rows.map((r) => r.key)).toEqual([...CAPABILITY_KEYS].sort());
    const providers = await db.query<{ key: string }>(
      "select key from public.provider_definitions order by key",
    );
    expect(providers.rows.map((r) => r.key)).toEqual(PROVIDERS.map((p) => p.key).sort());
  });

  it("marks the same capabilities available as the code registry", async () => {
    const available = await db.query<{ key: string }>(
      "select key from public.capability_definitions where status = 'available' order by key",
    );
    expect(available.rows.map((r) => r.key)).toEqual(
      CAPABILITY_KEYS.filter((k) => getCapability(k).status === "available").sort(),
    );
  });
});

describe("row level security", () => {
  it("isolates tasks between workspaces", async () => {
    await asUser(db, alice.userId, () =>
      db.query("insert into public.tasks (workspace_id, title) values ($1, 'Alice task')", [
        alice.workspaceId,
      ]),
    );

    const bobSees = await asUser(db, bob.userId, () => db.query("select id from public.tasks"));
    expect(bobSees.rows).toHaveLength(0);

    const bobUpdates = await asUser(db, bob.userId, () =>
      db.query("update public.tasks set title = 'hacked' where workspace_id = $1", [
        alice.workspaceId,
      ]),
    );
    expect(bobUpdates.affectedRows).toBe(0);

    await expect(
      asUser(db, bob.userId, () =>
        db.query("insert into public.tasks (workspace_id, title) values ($1, 'intrusion')", [
          alice.workspaceId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("does not allow physical task deletion from the client", async () => {
    const deleted = await asUser(db, alice.userId, () => db.query("delete from public.tasks"));
    expect(deleted.affectedRows).toBe(0);
  });

  it("isolates connections and prevents binding another workspace's connection", async () => {
    const bobConnections = await asUser(db, bob.userId, () =>
      db.query<{ id: string }>("select id from public.provider_connections"),
    );
    expect(bobConnections.rows).toHaveLength(1);

    const aliceConnection = await db.query<{ id: string }>(
      "select id from public.provider_connections where workspace_id = $1",
      [alice.workspaceId],
    );
    await expect(
      asUser(db, bob.userId, () =>
        db.query(
          "insert into public.capability_bindings (workspace_id, capability_key, connection_id) values ($1, 'tasks', $2)",
          [bob.workspaceId, aliceConnection.rows[0]!.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("keeps conversations private to their author", async () => {
    const conv = await asUser(db, alice.userId, () =>
      db.query<{ id: string }>(
        "insert into public.conversations (workspace_id, user_id, title) values ($1, $2, 'Private') returning id",
        [alice.workspaceId, alice.userId],
      ),
    );
    const bobSees = await asUser(db, bob.userId, () =>
      db.query("select id from public.conversations"),
    );
    expect(bobSees.rows).toHaveLength(0);

    await expect(
      asUser(db, bob.userId, () =>
        db.query(
          "insert into public.messages (conversation_id, workspace_id, role, content) values ($1, $2, 'user', 'hi')",
          [conv.rows[0]!.id, alice.workspaceId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("resolves an approval only once and never back to pending", async () => {
    const approvalId = await asUser(db, alice.userId, async () => {
      const action = await db.query<{ id: string }>(
        `insert into public.actions (workspace_id, user_id, tool_name, capability_key, operation, risk_level, origin, status, input_snapshot, input_hash)
         values ($1, $2, 'tasks.delete', 'tasks', 'delete', 'medium', 'ai', 'waiting_for_approval', '{}', 'h') returning id`,
        [alice.workspaceId, alice.userId],
      );
      const approval = await db.query<{ id: string }>(
        `insert into public.approvals (workspace_id, user_id, action_id, capability_key, operation, risk_level, payload_snapshot, payload_hash, summary, reason)
         values ($1, $2, $3, 'tasks', 'delete', 'medium', '{}', 'h', 'Delete task', 'Deleting data') returning id`,
        [alice.workspaceId, alice.userId, action.rows[0]!.id],
      );
      return approval.rows[0]!.id;
    });

    const resolve = (status: string) =>
      asUser(db, alice.userId, () =>
        db.query(
          "update public.approvals set status = $1, resolved_at = now() where id = $2 and status = 'pending'",
          [status, approvalId],
        ),
      );
    expect((await resolve("approved")).affectedRows).toBe(1);
    expect((await resolve("rejected")).affectedRows).toBe(0);

    const reopen = await asUser(db, alice.userId, () =>
      db.query("update public.approvals set status = 'pending', resolved_at = null where id = $1", [
        approvalId,
      ]),
    );
    expect(reopen.affectedRows).toBe(0);

    const bobSees = await asUser(db, bob.userId, () => db.query("select id from public.approvals"));
    expect(bobSees.rows).toHaveLength(0);
  });

  it("makes action payloads immutable and audit events append-only", async () => {
    await expect(
      asUser(db, alice.userId, () =>
        db.query("update public.actions set input_snapshot = '{\"x\":1}'"),
      ),
    ).rejects.toThrow(/immutable/);

    await asUser(db, alice.userId, () =>
      db.query(
        "insert into public.audit_events (workspace_id, user_id, event_type, origin, result) values ($1, $2, 'task.created', 'user_ui', 'success')",
        [alice.workspaceId, alice.userId],
      ),
    );
    const deleted = await asUser(db, alice.userId, () =>
      db.query("delete from public.audit_events"),
    );
    expect(deleted.affectedRows).toBe(0);
    const bobAudit = await asUser(db, bob.userId, () =>
      db.query("select id from public.audit_events"),
    );
    expect(bobAudit.rows).toHaveLength(0);
  });
});

describe("google connections", () => {
  async function googleConnection(workspaceId: string, sub: string) {
    const res = await db.query<{ id: string }>(
      `insert into public.provider_connections (workspace_id, provider_key, external_account_id, display_name, account_label)
       values ($1, 'google', $2, 'Personal', 'leo@gmail.com') returning id`,
      [workspaceId, sub],
    );
    return res.rows[0]!.id;
  }

  it("keeps encrypted credentials out of reach of every API user, owners included", async () => {
    const connectionId = await googleConnection(alice.workspaceId, "google-sub-a");
    await db.query(
      "insert into public.connection_secrets (connection_id, workspace_id, provider_key, ciphertext) values ($1, $2, 'google', 'v1.x')",
      [connectionId, alice.workspaceId],
    );
    await expect(
      asUser(db, alice.userId, () => db.query("select * from public.connection_secrets")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, alice.userId, () =>
        db.query("update public.connection_secrets set ciphertext = 'x' where connection_id = $1", [
          connectionId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);

    // The server-side credential store (service role) can read it.
    await db.exec("set role service_role");
    const asService = await db.query("select ciphertext from public.connection_secrets");
    await db.exec("reset role");
    expect(asService.rows).toHaveLength(1);
  });

  it("supports several Google accounts per workspace but not the same account twice", async () => {
    await googleConnection(alice.workspaceId, "google-sub-b");
    await expect(googleConnection(alice.workspaceId, "google-sub-b")).rejects.toThrow(
      /duplicate key/,
    );
    // The same Google account may be connected in another user's workspace.
    await expect(googleConnection(bob.workspaceId, "google-sub-b")).resolves.toBeTruthy();
  });

  it("isolates pending authorizations per user and consumes them once", async () => {
    const insert = (userId: string, workspaceId: string, hash: string) =>
      asUser(db, userId, () =>
        db.query(
          `insert into public.oauth_states (state_hash, workspace_id, user_id, provider_key, capabilities, code_verifier_ciphertext)
           values ($1, $2, $3, 'google', '{calendar}', 'v1.x')`,
          [hash, workspaceId, userId],
        ),
      );
    await insert(alice.userId, alice.workspaceId, "hash-alice");
    await expect(insert(bob.userId, alice.workspaceId, "hash-forged")).rejects.toThrow(
      /row-level security/,
    );

    const bobConsumes = await asUser(db, bob.userId, () =>
      db.query("delete from public.oauth_states where state_hash = 'hash-alice' returning id"),
    );
    expect(bobConsumes.rows).toHaveLength(0);

    const consume = () =>
      asUser(db, alice.userId, () =>
        db.query("delete from public.oauth_states where state_hash = 'hash-alice' returning id"),
      );
    expect((await consume()).rows).toHaveLength(1);
    expect((await consume()).rows).toHaveLength(0);
  });

  it("does not let a user bind or read another workspace's Google connection", async () => {
    const aliceGoogle = await googleConnection(alice.workspaceId, "google-sub-c");
    const bobReads = await asUser(db, bob.userId, () =>
      db.query("select id from public.provider_connections where id = $1", [aliceGoogle]),
    );
    expect(bobReads.rows).toHaveLength(0);
    await expect(
      asUser(db, bob.userId, () =>
        db.query(
          "insert into public.connection_capabilities (workspace_id, connection_id, capability_key) values ($1, $2, 'calendar')",
          [bob.workspaceId, aliceGoogle],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("schedules, runs and results", () => {
  async function schedule(owner: { userId: string; workspaceId: string }) {
    const res = await asUser(db, owner.userId, () =>
      db.query<{ id: string }>(
        `insert into public.schedules
           (workspace_id, created_by_user_id, name, schedule_type, timezone, schedule_definition, action_type, next_run_at)
         values ($1, $2, 'Morning Brief', 'recurring', 'America/Argentina/Buenos_Aires',
                 '{"kind":"weekly","days":[1,2,3,4,5],"time":"07:30"}', 'morning_brief', now())
         returning id`,
        [owner.workspaceId, owner.userId],
      ),
    );
    return res.rows[0]!.id;
  }
  // Server-side writes (service role) as the background runner does them.
  const insertRun = (workspaceId: string, scheduleId: string, at: string, status = "queued") =>
    db.query<{ id: string }>(
      `insert into public.schedule_runs (workspace_id, schedule_id, trigger, status, scheduled_for)
       values ($1, $2, 'scheduled', $3, $4) returning id`,
      [workspaceId, scheduleId, status, at],
    );

  it("keeps schedules private to their owner", async () => {
    const id = await schedule(alice);
    const bobSees = await asUser(db, bob.userId, () =>
      db.query("select id from public.schedules where id = $1", [id]),
    );
    expect(bobSees.rows).toHaveLength(0);
    await expect(
      asUser(db, bob.userId, () =>
        db.query(
          `insert into public.schedules (workspace_id, created_by_user_id, name, schedule_type, timezone, schedule_definition, action_type)
           values ($1, $2, 'x', 'recurring', 'UTC', '{}', 'morning_brief')`,
          [alice.workspaceId, bob.userId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("produces one run per occurrence and at most one active run per schedule", async () => {
    const id = await schedule(alice);
    await insertRun(alice.workspaceId, id, "2026-09-29T10:30:00Z");
    await expect(
      insertRun(alice.workspaceId, id, "2026-09-29T10:30:00Z", "skipped"),
    ).rejects.toThrow(/schedule_runs_occurrence_unique/);
    await expect(insertRun(alice.workspaceId, id, "2026-09-30T10:30:00Z")).rejects.toThrow(
      /schedule_runs_one_active/,
    );
    // A finished/skipped occurrence can be recorded while one is active.
    await insertRun(alice.workspaceId, id, "2026-09-30T10:30:00Z", "skipped");
  });

  it("lets users read their runs and results but only mark results as read", async () => {
    const id = await schedule(alice);
    const run = (await insertRun(alice.workspaceId, id, "2026-10-01T10:30:00Z", "completed"))
      .rows[0]!.id;
    const result = await db.query<{ id: string }>(
      `insert into public.scheduled_results (workspace_id, user_id, schedule_id, schedule_run_id, result_type, title, content)
       values ($1, $2, $3, $4, 'morning_brief', 'Morning Brief', '{}') returning id`,
      [alice.workspaceId, alice.userId, id, run],
    );
    const resultId = result.rows[0]!.id;
    await expect(
      db.query(
        `insert into public.scheduled_results (workspace_id, user_id, schedule_id, schedule_run_id, result_type, title, content)
         values ($1, $2, $3, $4, 'morning_brief', 'dup', '{}')`,
        [alice.workspaceId, alice.userId, id, run],
      ),
    ).rejects.toThrow(/duplicate key/);

    const seen = await asUser(db, alice.userId, () =>
      db.query("select id from public.schedule_runs where id = $1", [run]),
    );
    expect(seen.rows).toHaveLength(1);
    await expect(
      asUser(db, alice.userId, () =>
        db.query("update public.schedule_runs set status = 'completed' where id = $1", [run]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, alice.userId, () =>
        db.query("update public.scheduled_results set title = 'x' where id = $1", [resultId]),
      ),
    ).rejects.toThrow(/permission denied/);
    const marked = await asUser(db, alice.userId, () =>
      db.query("update public.scheduled_results set read_at = now() where id = $1", [resultId]),
    );
    expect(marked.affectedRows).toBe(1);

    const bobResults = await asUser(db, bob.userId, () =>
      db.query("select id from public.scheduled_results"),
    );
    expect(bobResults.rows).toHaveLength(0);
    const bobRuns = await asUser(db, bob.userId, () =>
      db.query("select id from public.schedule_runs"),
    );
    expect(bobRuns.rows).toHaveLength(0);
  });

  it("notifies once per run and type", async () => {
    const insert = () =>
      db.query(
        `insert into public.notifications (workspace_id, user_id, notification_type, title, source_type, source_id)
         values ($1, $2, 'schedule.result_ready', 'Morning Brief ready', 'schedule_run', 'run-1')`,
        [alice.workspaceId, alice.userId],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/notifications_schedule_run_once/);
  });
});

describe("knowledge", () => {
  const vec = (hot: number) =>
    `[${Array.from({ length: 1536 }, (_, i) => (i === hot ? 1 : 0)).join(",")}]`;

  async function space(
    owner: { userId: string; workspaceId: string },
    name: string,
    parent: string | null = null,
  ) {
    const res = await asUser(db, owner.userId, () =>
      db.query<{ id: string }>(
        "insert into public.knowledge_spaces (workspace_id, name, parent_space_id, created_by_user_id) values ($1, $2, $3, $4) returning id",
        [owner.workspaceId, name, parent, owner.userId],
      ),
    );
    return res.rows[0]!.id;
  }

  /** Server-side ingestion writes (service role), as the background runtime does. */
  async function indexedDoc(workspaceId: string, spaceId: string, content: string, hot: number) {
    const src = await db.query<{ id: string }>(
      "insert into public.knowledge_sources (workspace_id, space_id, provider_key, source_type, display_name) values ($1, $2, 'elise_native', 'upload', 'Uploads') on conflict do nothing returning id",
      [workspaceId, spaceId],
    );
    const sourceId =
      src.rows[0]?.id ??
      (
        await db.query<{ id: string }>(
          "select id from public.knowledge_sources where space_id = $1",
          [spaceId],
        )
      ).rows[0]!.id;
    const item = (
      await db.query<{ id: string }>(
        "insert into public.knowledge_items (workspace_id, space_id, source_id, item_type, external_id, title, status) values ($1, $2, $3, 'file', gen_random_uuid()::text, 'Doc', 'ready') returning id",
        [workspaceId, spaceId, sourceId],
      )
    ).rows[0]!.id;
    const version = (
      await db.query<{ id: string }>(
        "insert into public.knowledge_versions (workspace_id, knowledge_item_id, version_number, is_current, status) values ($1, $2, 1, true, 'ready') returning id",
        [workspaceId, item],
      )
    ).rows[0]!.id;
    await db.query("update public.knowledge_items set current_version_id = $1 where id = $2", [
      version,
      item,
    ]);
    await db.query(
      "insert into public.knowledge_chunks (workspace_id, space_id, source_id, knowledge_item_id, version_id, chunk_index, content, embedding, embedding_model) values ($1, $2, $3, $4, $5, 0, $6, $7, 'm')",
      [workspaceId, spaceId, sourceId, item, version, content, vec(hot)],
    );
    return { item, version, sourceId };
  }

  const search = (
    userId: string,
    workspaceId: string,
    keywords: string,
    hot: number | null,
    spaces: string[] | null = null,
  ) =>
    asUser(db, userId, () =>
      db.query<{ content: string; similarity: number | null; keyword_rank: number | null }>(
        "select content, similarity, keyword_rank from public.search_knowledge_chunks($1, $2, $3, 'm', $4, null, 10)",
        [workspaceId, keywords, hot === null ? null : vec(hot), spaces],
      ),
    );

  it("keeps Spaces in one workspace and refuses cycles", async () => {
    const work = await space(alice, "Work");
    const firbot = await space(alice, "Firbot", work);
    await expect(
      asUser(db, alice.userId, () =>
        db.query("update public.knowledge_spaces set parent_space_id = $1 where id = $2", [
          firbot,
          work,
        ]),
      ),
    ).rejects.toThrow(/cannot be moved under itself/);
    await expect(space(bob, "Sneaky", work)).rejects.toThrow(/same workspace|row-level security/);
    const bobSees = await asUser(db, bob.userId, () =>
      db.query("select id from public.knowledge_spaces"),
    );
    expect(bobSees.rows).toHaveLength(0);
  });

  it("hybrid search is scoped to the workspace, the Space and current versions", async () => {
    const rsfa = await space(alice, "RSFA");
    const other = await space(alice, "Personal");
    await indexedDoc(
      alice.workspaceId,
      rsfa,
      "The Unique ID links each email to the client file.",
      1,
    );
    await indexedDoc(alice.workspaceId, other, "Grocery list and weekend plans.", 2);
    const bobSpace = await space(bob, "Bob");
    await indexedDoc(bob.workspaceId, bobSpace, "Bob's secret email filing notes.", 1);

    // Semantic + keyword, within one Space.
    const inSpace = await search(alice.userId, alice.workspaceId, "email | filing", 1, [rsfa]);
    expect(inSpace.rows.map((r) => r.content)).toEqual([
      "The Unique ID links each email to the client file.",
    ]);
    expect(inSpace.rows[0]!.similarity).toBeCloseTo(1);
    expect(inSpace.rows[0]!.keyword_rank).toBe(1);

    // Keyword-only still works (no embedding available).
    const keywordOnly = await search(alice.userId, alice.workspaceId, "grocery", null);
    expect(keywordOnly.rows.map((r) => r.content)).toEqual(["Grocery list and weekend plans."]);

    // Another workspace's vectors are never returned, even asking with its id.
    const crossed = await search(alice.userId, bob.workspaceId, "email | filing", 1);
    expect(crossed.rows).toHaveLength(0);
    const own = await search(alice.userId, alice.workspaceId, "secret", 1);
    expect(own.rows.map((r) => r.content)).not.toContain("Bob's secret email filing notes.");
  });

  it("stops returning an item once it is removed or superseded", async () => {
    const s = await space(alice, "Drive");
    const { item } = await indexedDoc(alice.workspaceId, s, "Quarterly revenue forecast.", 3);
    expect(
      (await search(alice.userId, alice.workspaceId, "forecast", null, [s])).rows,
    ).toHaveLength(1);
    await db.query("update public.knowledge_items set status = 'removed' where id = $1", [item]);
    expect(
      (await search(alice.userId, alice.workspaceId, "forecast", null, [s])).rows,
    ).toHaveLength(0);
  });

  it("lets users read their Knowledge but not write the index directly", async () => {
    const s = await space(alice, "Locked");
    const { item } = await indexedDoc(alice.workspaceId, s, "Content.", 4);
    await expect(
      asUser(db, alice.userId, () =>
        db.query("update public.knowledge_items set title = 'x' where id = $1", [item]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(db, alice.userId, () => db.query("delete from public.knowledge_chunks")),
    ).rejects.toThrow(/permission denied/);
    const bobChunks = await asUser(db, bob.userId, () =>
      db.query("select id from public.knowledge_chunks where knowledge_item_id = $1", [item]),
    );
    expect(bobChunks.rows).toHaveLength(0);
  });

  it("stores originals in a private bucket", async () => {
    const bucket = await db.query<{ public: boolean; file_size_limit: number }>(
      "select public, file_size_limit from storage.buckets where id = 'knowledge-originals'",
    );
    expect(bucket.rows[0]).toMatchObject({ public: false, file_size_limit: 26214400 });
  });
});

describe("my elise native", () => {
  const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
    asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));

  it("keeps habits, goals, lists and notes inside their workspace", async () => {
    const habit = (
      await as<{ id: string }>(
        alice,
        "insert into public.habits (workspace_id, name, frequency_type, target_value) values ($1, 'Run', 'weekly', 3) returning id",
        [alice.workspaceId],
      )
    ).rows[0]!.id;
    await as(
      alice,
      "insert into public.notes (workspace_id, title, content) values ($1, 'ELISE ideas', 'proactive meeting preparation')",
      [alice.workspaceId],
    );
    for (const table of ["habits", "notes", "goals", "lists"]) {
      expect((await as(bob, `select id from public.${table}`)).rows).toHaveLength(0);
    }
    await expect(
      as(
        bob,
        "insert into public.habit_entries (workspace_id, habit_id, entry_date) values ($1, $2, '2026-09-30')",
        [bob.workspaceId, habit],
      ),
    ).rejects.toThrow(/same workspace/);
    await expect(as(alice, "delete from public.habits where id = $1", [habit])).rejects.toThrow(
      /permission denied/,
    );
  });

  it("stores one check-in per habit and day", async () => {
    const habit = (
      await as<{ id: string }>(
        alice,
        "insert into public.habits (workspace_id, name, frequency_type) values ($1, 'Gym', 'weekly') returning id",
        [alice.workspaceId],
      )
    ).rows[0]!.id;
    const insert = () =>
      as(
        alice,
        "insert into public.habit_entries (workspace_id, habit_id, entry_date) values ($1, $2, '2026-09-30')",
        [alice.workspaceId, habit],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it("links goals only to records of the same workspace", async () => {
    const goal = (
      await as<{ id: string }>(
        alice,
        "insert into public.goals (workspace_id, title) values ($1, 'Half marathon') returning id",
        [alice.workspaceId],
      )
    ).rows[0]!.id;
    const own = (
      await as<{ id: string }>(
        alice,
        "insert into public.habits (workspace_id, name, frequency_type) values ($1, 'Running', 'weekly') returning id",
        [alice.workspaceId],
      )
    ).rows[0]!.id;
    const foreign = (
      await as<{ id: string }>(
        bob,
        "insert into public.habits (workspace_id, name, frequency_type) values ($1, 'Bob run', 'weekly') returning id",
        [bob.workspaceId],
      )
    ).rows[0]!.id;
    await as(
      alice,
      "insert into public.goal_links (workspace_id, goal_id, resource_type, resource_id) values ($1, $2, 'habit', $3)",
      [alice.workspaceId, goal, own],
    );
    await expect(
      as(
        alice,
        "insert into public.goal_links (workspace_id, goal_id, resource_type, resource_id) values ($1, $2, 'habit', $3)",
        [alice.workspaceId, goal, foreign],
      ),
    ).rejects.toThrow(/same workspace/);
  });

  it("finds notes by full text", async () => {
    const found = await as<{ title: string }>(
      alice,
      "select title from public.notes where fts @@ to_tsquery('simple', 'meeting | preparation')",
    );
    expect(found.rows.map((r) => r.title)).toContain("ELISE ideas");
  });
});

describe("native task lists", () => {
  const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
    asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));

  it("gives every workspace one default Inbox, private to it", async () => {
    const lists = await as<{ name: string; is_default: boolean }>(
      alice,
      "select name, is_default from public.task_lists where status = 'active'",
    );
    expect(lists.rows).toEqual([{ name: "Inbox", is_default: true }]);
    await expect(
      as(
        alice,
        "insert into public.task_lists (workspace_id, name, is_default) values ($1, 'Other', true)",
        [alice.workspaceId],
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      as(alice, "insert into public.task_lists (workspace_id, name) values ($1, 'inbox')", [
        alice.workspaceId,
      ]),
    ).rejects.toThrow(/duplicate key/);
    const inbox = (
      await as<{ id: string }>(alice, "select id from public.task_lists where is_default")
    ).rows[0]!.id;
    // Bob can't file a task into Alice's list, nor delete lists.
    await expect(
      as(bob, "insert into public.tasks (workspace_id, title, task_list_id) values ($1, 'x', $2)", [
        bob.workspaceId,
        inbox,
      ]),
    ).rejects.toThrow(/row-level security/);
    await expect(as(alice, "delete from public.task_lists where id = $1", [inbox])).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe("knowledge space appearance", () => {
  it("stores a curated icon and color key and refuses anything else", async () => {
    const insert = (icon: string | null, color: string | null) =>
      db.query(
        "insert into public.knowledge_spaces (workspace_id, name, icon, color) values ($1, $2, $3, $4) returning icon, color",
        [alice.workspaceId, `S ${Math.random()}`, icon, color],
      );
    await expect(insert("graduation", "blue")).resolves.toMatchObject({
      rows: [{ icon: "graduation", color: "blue" }],
    });
    await expect(insert("<svg onload=x>", "blue")).rejects.toThrow(/check/);
    await expect(insert("folder", "#ff0000")).rejects.toThrow(/check/);
  });
});

describe("finance", () => {
  const as = <T>(u: { userId: string }, sql: string, args: unknown[] = []) =>
    asUser(db, u.userId, () => db.query<T & Record<string, unknown>>(sql, args));

  it("stores exact decimals and keeps transactions inside their workspace", async () => {
    const tx = (
      await as<{ id: string; amount: string }>(
        alice,
        `insert into public.finance_transactions
           (workspace_id, transaction_type, amount, currency, transaction_date, counterparty, fingerprint)
         values ($1, 'expense', '0.1', 'USD', '2026-09-29', 'OpenAI', 'fp') returning id, amount::text`,
        [alice.workspaceId],
      )
    ).rows[0]!;
    await as(
      alice,
      `insert into public.finance_transactions (workspace_id, transaction_type, amount, currency, transaction_date, fingerprint)
       values ($1, 'expense', '0.2', 'USD', '2026-09-29', 'fp2')`,
      [alice.workspaceId],
    );
    const sum = await as<{ total: string }>(
      alice,
      "select sum(amount)::text as total from public.finance_transactions where currency = 'USD'",
    );
    expect(sum.rows[0]!.total).toBe("0.3000");
    expect((await as(bob, "select id from public.finance_transactions")).rows).toHaveLength(0);
    await expect(
      as(bob, "update public.finance_transactions set amount = 1 where id = $1 returning id", [
        tx.id,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      as(alice, "delete from public.finance_transactions where id = $1", [tx.id]),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses invalid money and currencies", async () => {
    const insert = (amount: string, currency: string) =>
      as(
        alice,
        `insert into public.finance_transactions (workspace_id, transaction_type, amount, currency, transaction_date, fingerprint)
         values ($1, 'expense', $2, $3, '2026-09-29', 'fp')`,
        [alice.workspaceId, amount, currency],
      );
    await expect(insert("-5", "USD")).rejects.toThrow(/check/);
    await expect(insert("5", "usd")).rejects.toThrow(/check/);
    await expect(insert("5", "DOLLARS")).rejects.toThrow(/check/);
  });

  it("links accounts, categories and imports only within the workspace", async () => {
    const account = (
      await as<{ id: string }>(
        alice,
        "insert into public.finance_accounts (workspace_id, name, account_type, currency) values ($1, 'Visa', 'credit_card', 'ARS') returning id",
        [alice.workspaceId],
      )
    ).rows[0]!.id;
    await expect(
      as(
        bob,
        `insert into public.finance_transactions (workspace_id, transaction_type, amount, currency, transaction_date, account_id, fingerprint)
         values ($1, 'expense', 1, 'ARS', '2026-09-29', $2, 'fp')`,
        [bob.workspaceId, account],
      ),
    ).rejects.toThrow(/same workspace/);
    expect((await as(bob, "select id from public.finance_accounts")).rows).toHaveLength(0);
    await expect(
      as(alice, "insert into public.finance_accounts (workspace_id, name) values ($1, 'visa')", [
        alice.workspaceId,
      ]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("lets members read connected-sheet rows and import rows, but only ELISE's server write them", async () => {
    const conn = (
      await db.query<{ id: string }>(
        `insert into public.provider_connections (workspace_id, provider_key, external_account_id, display_name, status)
         values ($1, 'google', 'g-alice', 'Personal', 'connected') returning id`,
        [alice.workspaceId],
      )
    ).rows[0]!.id;
    const source = (
      await as<{ id: string }>(
        alice,
        `insert into public.finance_sources (workspace_id, connection_id, display_name, spreadsheet_id, sheet_id, sheet_title)
         values ($1, $2, 'Firbot Revenue', 'abcdefghijklmnopqrstuvwxyz', 0, 'Ingresos') returning id`,
        [alice.workspaceId, conn],
      )
    ).rows[0]!.id;
    // Service role (the sync) writes the mirror.
    await db.query(
      `insert into public.finance_source_rows (workspace_id, source_id, row_key, row_number, transaction_type, amount, currency, transaction_date, fingerprint)
       values ($1, $2, 'k#1', 2, 'income', 1500, 'USD', '2026-09-10', 'k')`,
      [alice.workspaceId, source],
    );
    expect((await as(alice, "select id from public.finance_source_rows")).rows).toHaveLength(1);
    expect((await as(bob, "select id from public.finance_source_rows")).rows).toHaveLength(0);
    await expect(
      as(
        alice,
        `insert into public.finance_source_rows (workspace_id, source_id, row_key, row_number, transaction_type, amount, currency, transaction_date, fingerprint)
         values ($1, $2, 'k#2', 3, 'income', 1, 'USD', '2026-09-10', 'k2')`,
        [alice.workspaceId, source],
      ),
    ).rejects.toThrow(/permission denied/);
    // Bob can't attach a source to Alice's Google connection.
    await expect(
      as(
        bob,
        `insert into public.finance_sources (workspace_id, connection_id, display_name, spreadsheet_id, sheet_id, sheet_title)
         values ($1, $2, 'x', 'abcdefghijklmnopqrstuvwxyz', 1, 'x')`,
        [bob.workspaceId, conn],
      ),
    ).rejects.toThrow(/same workspace/);
    await expect(
      as(
        alice,
        "insert into public.import_rows (workspace_id, import_id, source_row_number, status) values ($1, gen_random_uuid(), 2, 'invalid')",
        [alice.workspaceId],
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
