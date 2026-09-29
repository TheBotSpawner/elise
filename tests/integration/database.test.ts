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

  it("provisions ELISE Native as a connected provider with a default Tasks binding", async () => {
    const rows = await db.query<{
      provider_key: string;
      capability_key: string;
      is_default: boolean;
    }>(
      `select c.provider_key, b.capability_key, b.is_default
       from public.capability_bindings b join public.provider_connections c on c.id = b.connection_id
       where b.workspace_id = $1`,
      [alice.workspaceId],
    );
    expect(rows.rows).toEqual([
      { provider_key: "elise_native", capability_key: "tasks", is_default: true },
    ]);
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
