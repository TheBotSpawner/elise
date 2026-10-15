import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import type { SlackGrant, SlackIdentity } from "@/infrastructure/providers/slack/oauth";

import { FakeSupabase } from "../../fixtures/fake-supabase";

/**
 * Slack OAuth v2 connections (ADR-062): CSRF-safe single-use state, one connection per user and
 * workspace, safe reconnect and progressive scopes on the same grant, encrypted tokens that
 * never reach the browser.
 */

vi.setConfig({ testTimeout: 30_000 });

const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/infrastructure/supabase/admin", () => ({ createAdminClient: () => store.db }));

const TOKEN = "xoxp-SECRET-user-token-never-leaves";
const KEY = Buffer.alloc(32, 9).toString("base64");

let db: FakeSupabase;
const auth = (userId = "user-a", workspaceId = "ws-a") =>
  ({
    db,
    userId,
    workspaceId,
    profile: { timezone: "UTC", locale: "es" },
  }) as unknown as AuthContext;

function grant(over: Partial<SlackGrant> = {}): SlackGrant {
  return {
    userId: "U1",
    teamId: "T1",
    teamName: "Firbot",
    enterpriseId: null,
    enterpriseName: null,
    tokens: {
      accessToken: TOKEN,
      refreshToken: null,
      expiresAt: new Date("2999-01-01"),
      scopes: [
        "search:read.public",
        "search:read.users",
        "channels:read",
        "channels:history",
        "users:read",
        "team:read",
        "chat:write",
        "im:write",
      ],
    },
    rotating: false,
    ...over,
  };
}
const identity = async (): Promise<SlackIdentity> => ({
  userName: "Leo",
  handle: "leo",
  teamName: "Firbot",
  teamDomain: "firbot",
  teamIcon: "https://avatars.slack-edge.com/firbot.png",
});

async function service() {
  return import("@/application/connections-service");
}

/** Starts a flow and returns the state Slack would echo back. */
async function start(a: AuthContext, permissions: string[] = [], connectionId?: string) {
  const { startSlackConnection } = await service();
  const url = new URL(
    await startSlackConnection(a, { permissions, connectionId, origin: "https://elise.test" }),
  );
  return { url, state: url.searchParams.get("state")! };
}

async function complete(
  a: AuthContext,
  state: string,
  g = grant(),
  revoke = vi.fn(async () => true),
) {
  const { completeSlackConnection } = await service();
  return completeSlackConnection(
    a,
    { code: "code-1", state, error: null, origin: "https://elise.test" },
    { exchange: async () => g, identity, revoke },
  );
}

beforeEach(() => {
  db = new FakeSupabase();
  db.defaults.capability_bindings = { context_type: null, context_id: null, is_default: false };
  store.db = db;
  vi.stubEnv("SLACK_CLIENT_ID", "111.222");
  vi.stubEnv("SLACK_CLIENT_SECRET", "slack-client-secret");
  vi.stubEnv("ELISE_ENCRYPTION_KEY", KEY);
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://elise.test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Slack OAuth start", () => {
  it("asks for user scopes only, with a single-use state and the exact callback", async () => {
    const { url } = await start(auth(), ["private", "bogus"]);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://elise.test/api/connections/slack/callback",
    );
    expect(url.searchParams.has("scope")).toBe(false);
    const scopes = url.searchParams.get("user_scope")!.split(",");
    expect(scopes).toEqual(expect.arrayContaining(["search:read.public", "search:read.private"]));
    expect(scopes).not.toContain("search:read.im");
    expect(scopes).not.toContain("search:read");
    // Stored hashed, never the raw state; the unknown permission is dropped.
    const row = db.rows("oauth_states")[0]!;
    expect(row.state_hash).not.toBe(url.searchParams.get("state"));
    expect(row.capabilities).toEqual(["public", "private"]);
  });

  it("missing client settings are a server setup problem, never 'not connected'", async () => {
    vi.stubEnv("SLACK_CLIENT_SECRET", "");
    vi.resetModules();
    const { startSlackConnection } = await service();
    await expect(
      startSlackConnection(auth(), { permissions: [], origin: "https://elise.test" }),
    ).rejects.toMatchObject({ code: "SERVER_NOT_CONFIGURED" });
  });
});

describe("Slack OAuth callback", () => {
  it("connects a workspace: identity, binding, encrypted token", async () => {
    const { state } = await start(auth());
    const result = await complete(auth(), state);
    expect(result.enabled).toEqual(["team_messaging"]);

    const conn = db.rows("provider_connections")[0]!;
    expect(conn).toMatchObject({
      provider_key: "slack",
      external_account_id: "T1:U1",
      display_name: "Firbot",
      account_label: "Leo · Firbot",
      status: "connected",
    });
    expect(JSON.stringify(conn.auth_metadata)).not.toContain(TOKEN);

    const secret = db.rows("connection_secrets")[0]!;
    expect(secret.provider_key).toBe("slack");
    expect(String(secret.ciphertext)).not.toContain(TOKEN);
    const { SupabaseCredentialVault } =
      await import("@/infrastructure/providers/google/connection-vault");
    const stored = await new SupabaseCredentialVault(db as never, "slack").read({
      connectionId: result.connectionId,
      workspaceId: "ws-a",
    });
    expect(stored?.accessToken).toBe(TOKEN);

    expect(db.rows("connection_capabilities")[0]).toMatchObject({
      capability_key: "team_messaging",
      enabled: true,
    });
    expect(db.rows("capability_bindings")[0]).toMatchObject({
      capability_key: "team_messaging",
      is_default: true,
    });
  });

  it("refuses a reused, foreign or missing state", async () => {
    const { state } = await start(auth());
    await complete(auth(), state);
    await expect(complete(auth(), state)).rejects.toMatchObject({ code: "CONFLICT" });

    const other = await start(auth());
    await expect(complete(auth("user-b"), other.state)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const { completeSlackConnection } = await service();
    await expect(
      completeSlackConnection(auth(), { code: "x", state: null, error: null, origin: "" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("a declined consent is a clear refusal, not a broken connection", async () => {
    const { state } = await start(auth());
    const { completeSlackConnection } = await service();
    await expect(
      completeSlackConnection(auth(), {
        code: null,
        state,
        error: "access_denied",
        origin: "https://elise.test",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(db.rows("provider_connections")).toHaveLength(0);
  });

  it("reconnecting the same workspace updates it; progressive scopes accumulate", async () => {
    const first = await complete(auth(), (await start(auth())).state);
    const more = grant({
      tokens: {
        ...grant().tokens,
        scopes: ["search:read.private", "groups:read", "groups:history"],
      },
    });
    const again = await complete(
      auth(),
      (await start(auth(), ["private"], first.connectionId)).state,
      more,
    );
    expect(again.connectionId).toBe(first.connectionId);
    expect(db.rows("provider_connections")).toHaveLength(1);
    const scopes = db.rows("connection_capabilities")[0]!.authorized_scopes as string[];
    expect(scopes).toEqual(expect.arrayContaining(["channels:history", "groups:history"]));

    const { listConnections } = await service();
    const { connections } = await listConnections(auth());
    const perms = connections[0]!.slack!.permissions;
    expect(perms.find((p) => p.key === "private")?.granted).toBe(true);
    expect(perms.find((p) => p.key === "direct")?.granted).toBe(false);
  });

  it("several workspaces (and users) are separate connections", async () => {
    await complete(auth(), (await start(auth())).state);
    await complete(
      auth(),
      (await start(auth())).state,
      grant({ teamId: "T2", teamName: "Centro Larrea" }),
    );
    await complete(auth(), (await start(auth())).state, grant({ userId: "U9" }));
    const keys = db.rows("provider_connections").map((c) => c.external_account_id);
    expect(keys).toEqual(["T1:U1", "T2:U1", "T1:U9"]);
    // The first is the default; the others don't take it.
    expect(db.rows("capability_bindings").filter((b) => b.is_default)).toHaveLength(1);
  });

  it("reconnecting a connection with another workspace is refused and the new token revoked", async () => {
    const first = await complete(auth(), (await start(auth())).state);
    const revoke = vi.fn(async () => true);
    const { state } = await start(auth(), [], first.connectionId);
    await expect(complete(auth(), state, grant({ teamId: "T2" }), revoke)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(revoke).toHaveBeenCalledWith(TOKEN);
  });

  it("what Connections sends to the browser never contains a token", async () => {
    await complete(auth(), (await start(auth())).state);
    const { listConnections } = await service();
    const view = await listConnections(auth());
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(view)).not.toContain("slack-client-secret");
    expect(view.connections[0]!.slack).toMatchObject({
      team: "Firbot",
      user: "Leo",
      icon: "https://avatars.slack-edge.com/firbot.png",
    });
  });

  it("another user's workspace can't reach this connection", async () => {
    await complete(auth(), (await start(auth())).state);
    const { listConnections } = await service();
    expect((await listConnections(auth("user-b", "ws-b"))).connections).toHaveLength(0);
  });
});
