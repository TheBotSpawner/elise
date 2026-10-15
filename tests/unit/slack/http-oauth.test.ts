import { describe, expect, it, vi } from "vitest";

import {
  GoogleTokenProvider,
  type CredentialVault,
  type StoredCredential,
} from "@/infrastructure/providers/google/credentials";
import { retryDelay, SlackHttp, type SlackCallLog } from "@/infrastructure/providers/slack/http";
import {
  exchangeCode,
  grantedAccess,
  grantedPermissions,
  refreshAccessToken,
  scopesFor,
  slackAuthError,
} from "@/infrastructure/providers/slack/oauth";

const config = {
  clientId: "111.222",
  clientSecret: "client-secret",
  redirectUri: "https://elise.test/api/connections/slack/callback",
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("Slack scopes and grants", () => {
  it("public channels are always asked for; legacy search only when configured", () => {
    expect(scopesFor([])).toEqual(
      expect.arrayContaining(["search:read.public", "channels:history"]),
    );
    expect(scopesFor(["direct"])).toEqual(expect.arrayContaining(["search:read.im", "im:history"]));
    expect(scopesFor([])).not.toContain("search:read");
    expect(scopesFor([], true)).toContain("search:read");
  });

  it("a permission counts only when every scope ELISE uses for it was granted", () => {
    const base = scopesFor([]);
    expect(grantedAccess(base)).toEqual(["public", "people"]);
    // Search granted but not the history read that expands a result: not private yet.
    expect(grantedAccess([...base, "search:read.private"])).not.toContain("private");
    expect(grantedAccess([...base, ...scopesFor(["private", "send", "reactions"])])).toEqual(
      expect.arrayContaining(["private", "send", "reactions"]),
    );
    expect(grantedPermissions(base)).toEqual(["public"]);
  });
});

describe("Slack token exchange", () => {
  it("reads the user token from authed_user; long-lived tokens never expire", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain("redirect_uri=https%3A%2F%2Felise.test");
      return json({
        ok: true,
        authed_user: { id: "U1", scope: "search:read.public,users:read", access_token: "xoxp-1" },
        team: { id: "T1", name: "Firbot" },
        enterprise: null,
      });
    });
    const g = await exchangeCode(config, "code", fetchImpl);
    expect(g).toMatchObject({ userId: "U1", teamId: "T1", teamName: "Firbot", rotating: false });
    expect(g.tokens.scopes).toEqual(["search:read.public", "users:read"]);
    expect(g.tokens.expiresAt.getUTCFullYear()).toBe(2999);
  });

  it("detects token rotation and refreshes with the single-use refresh token", async () => {
    const install = await exchangeCode(config, "code", async () =>
      json({
        ok: true,
        authed_user: {
          id: "U1",
          scope: "chat:write",
          access_token: "xoxe.xoxp-1",
          refresh_token: "xoxe-1-a",
          expires_in: 43200,
        },
        team: { id: "T1" },
      }),
    );
    expect(install.rotating).toBe(true);
    const next = await refreshAccessToken(config, "xoxe-1-a", async (_u, init) => {
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return json({
        ok: true,
        access_token: "xoxe.xoxp-2",
        refresh_token: "xoxe-1-b",
        expires_in: 43200,
      });
    });
    expect(next).toMatchObject({ accessToken: "xoxe.xoxp-2", refreshToken: "xoxe-1-b" });
  });

  it("maps Slack's refusals to ELISE errors", () => {
    expect(slackAuthError("invalid_refresh_token").code).toBe("AUTH_EXPIRED");
    expect(slackAuthError("token_revoked").code).toBe("AUTH_EXPIRED");
    expect(slackAuthError("bad_client_secret").code).toBe("SERVER_NOT_CONFIGURED");
    expect(slackAuthError("access_denied").code).toBe("PERMISSION_DENIED");
    expect(slackAuthError("ratelimited").code).toBe("RATE_LIMITED");
  });
});

describe("Slack HTTP client", () => {
  const tokens = (calls: boolean[] = []) => ({
    accessToken: async (force = false) => (calls.push(force), force ? "fresh" : "stale"),
  });

  it("honours Retry-After (with bounded jitter) and then succeeds", async () => {
    const sleeps: number[] = [];
    const logs: SlackCallLog[] = [];
    let n = 0;
    const http = new SlackHttp(tokens(), {
      fetchImpl: async () =>
        ++n === 1
          ? json({ ok: false, error: "ratelimited" }, 429, { "retry-after": "2" })
          : json({ ok: true, x: 1 }),
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
      log: (e) => logs.push(e),
    });
    expect(
      await http.call<{ x: number }>("conversations.history", { channel: "C1" }),
    ).toMatchObject({ x: 1 });
    expect(sleeps).toEqual([2200]);
    expect(logs[0]).toMatchObject({
      method: "conversations.history",
      attempts: 2,
      rateLimited: true,
      ok: true,
    });
    // Telemetry never carries arguments or content.
    expect(JSON.stringify(logs)).not.toContain("C1");
  });

  it("a long Retry-After is RATE_LIMITED right away, never a disconnect", async () => {
    const http = new SlackHttp(tokens(), {
      fetchImpl: async () => json({ ok: false }, 429, { "retry-after": "60" }),
      sleep: async () => undefined,
    });
    await expect(http.call("conversations.replies", {})).rejects.toMatchObject({
      code: "RATE_LIMITED",
      details: { retryAfterSeconds: 60 },
    });
  });

  it("retries once with a fresh token when a rotated token expired", async () => {
    const forced: boolean[] = [];
    let n = 0;
    const http = new SlackHttp(tokens(forced), {
      fetchImpl: async () =>
        ++n === 1 ? json({ ok: false, error: "token_expired" }) : json({ ok: true }),
    });
    await http.call("auth.test", {});
    expect(forced).toEqual([false, true]);
  });

  it("revoked access marks the connection; a missing scope never does", async () => {
    const onUnauthorized = vi.fn(async () => undefined);
    const revoked = new SlackHttp(tokens(), {
      fetchImpl: async () => json({ ok: false, error: "token_revoked" }),
      onUnauthorized,
    });
    await expect(revoked.call("auth.test", {})).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(onUnauthorized).toHaveBeenCalledWith("token_revoked");

    onUnauthorized.mockClear();
    const scoped = new SlackHttp(tokens(), {
      fetchImpl: async () => json({ ok: false, error: "missing_scope", needed: "groups:history" }),
      onUnauthorized,
    });
    await expect(scoped.call("conversations.history", {})).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { reason: "missing_scope", needed: "groups:history" },
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("a write Slack didn't confirm is UNKNOWN_OUTCOME; a read is temporary", async () => {
    const http = new SlackHttp(tokens(), { fetchImpl: async () => json({}, 503) });
    await expect(http.call("chat.postMessage", { text: "hola" })).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
    });
    await expect(http.call("conversations.history", {})).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("maps not-found and search-unavailable distinctly", async () => {
    const as = (error: string) =>
      new SlackHttp(tokens(), { fetchImpl: async () => json({ ok: false, error }) }).call("x", {});
    await expect(as("channel_not_found")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as("feature_not_enabled")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "search_unavailable" },
    });
  });

  it("retryDelay falls back to exponential backoff", () => {
    expect(retryDelay(new Response(null, { status: 429 }), 2, () => 0)).toBe(2000);
  });
});

describe("Rotating tokens under a refresh lease", () => {
  class Vault implements CredentialVault {
    constructor(public value: StoredCredential) {}
    async read() {
      return { ...this.value };
    }
    async write(_r: unknown, c: StoredCredential) {
      this.value = c;
    }
    async remove() {}
  }
  const expired = (): StoredCredential => ({
    accessToken: "old",
    accessTokenExpiresAt: new Date(0).toISOString(),
    refreshToken: "r1",
    scopes: ["chat:write"],
  });

  it("redeems a single-use refresh token once, even with concurrent callers", async () => {
    const vault = new Vault(expired());
    let held = false;
    const lease = {
      acquire: async () => (held ? false : (held = true)),
      release: async () => void (held = false),
    };
    const refresh = vi.fn(async (token: string) => {
      expect(token).toBe("r1");
      await new Promise((r) => setTimeout(r, 20));
      return {
        accessToken: "new",
        refreshToken: "r2",
        expiresAt: new Date(Date.now() + 43_200_000),
        scopes: [],
      };
    });
    const make = () =>
      new GoogleTokenProvider(
        { connectionId: "c", workspaceId: "w" },
        {
          vault,
          refresh,
          lease,
          onReauthorizationRequired: async () => undefined,
          sleep: (ms) => new Promise((r) => setTimeout(r, ms / 50)),
        },
      );
    const tokens = await Promise.all([
      make().accessToken(),
      make().accessToken(),
      make().accessToken(),
    ]);
    expect(tokens).toEqual(["new", "new", "new"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The replacement refresh token was persisted; the scopes were kept.
    expect(vault.value).toMatchObject({ refreshToken: "r2", scopes: ["chat:write"] });
  });

  it("a revoked refresh token asks to reconnect", async () => {
    const onReauthorizationRequired = vi.fn(async () => undefined);
    const p = new GoogleTokenProvider(
      { connectionId: "c", workspaceId: "w" },
      {
        vault: new Vault(expired()),
        refresh: async () => {
          throw slackAuthError("invalid_refresh_token");
        },
        lease: { acquire: async () => true, release: async () => undefined },
        onReauthorizationRequired,
        providerName: "Slack",
      },
    );
    await expect(p.accessToken()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(onReauthorizationRequired).toHaveBeenCalledWith(
      { connectionId: "c", workspaceId: "w" },
      "revoked",
    );
  });
});
