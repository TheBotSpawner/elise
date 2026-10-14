import { describe, expect, it, vi } from "vitest";

import { validatePendingAuthorization } from "@/application/connections-service";
import {
  credentialFromTokens,
  GoogleTokenProvider,
  type CredentialVault,
  type StoredCredential,
} from "@/infrastructure/providers/google/credentials";
import { createPkce, createState, hashState } from "@/infrastructure/providers/google/oauth";
import { GraphHttp, retryDelay } from "@/infrastructure/providers/microsoft/http";
import {
  authError,
  buildAuthorizationUrl,
  exchangeCode,
  fetchIdentity,
  grantedCapabilities,
  microsoftAuthReason,
  refreshAccessToken,
  scopesFor,
  suggestAlias,
} from "@/infrastructure/providers/microsoft/oauth";

const config = {
  clientId: "client-id",
  clientSecret: "server-secret",
  redirectUri: "http://localhost:3000/api/connections/microsoft/callback",
  tenant: "common",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

class MemoryVault implements CredentialVault {
  constructor(public value: StoredCredential | null) {}
  async read() {
    return this.value;
  }
  async write(_ref: unknown, credential: StoredCredential) {
    this.value = credential;
  }
  async remove() {
    this.value = null;
  }
}

describe("Microsoft authorization", () => {
  it("uses the common authority, PKCE (S256), delegated mail scopes and account selection", () => {
    const pkce = createPkce();
    const { state } = createState();
    const url = new URL(
      buildAuthorizationUrl(config, {
        scopes: scopesFor(["email"]),
        state,
        codeChallenge: pkce.challenge,
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual([
      "openid",
      "profile",
      "offline_access",
      "User.Read",
      "Mail.ReadWrite",
      "Mail.Send",
    ]);
    // Never application-wide or shared-mailbox permissions; the secret never goes to the browser.
    expect(scopes.some((s) => /\.default|Shared|\.All$/.test(s))).toBe(false);
    expect(url.toString()).not.toContain("server-secret");
  });

  it("state is single-use by hash and bound to the session that started it", () => {
    const { state, hash } = createState();
    expect(hashState(state)).toBe(hash);
    const row = {
      user_id: "u1",
      workspace_id: "w1",
      provider_key: "microsoft",
      expires_at: "2026-10-14T12:10:00Z",
    };
    const now = new Date("2026-10-14T12:00:00Z");
    expect(() =>
      validatePendingAuthorization(row, {
        userId: "u1",
        workspaceId: "w1",
        providerKey: "microsoft",
        now,
      }),
    ).not.toThrow();
    expect(() =>
      validatePendingAuthorization(row, {
        userId: "u2",
        workspaceId: "w1",
        providerKey: "microsoft",
        now,
      }),
    ).toThrow();
    // A Google state cannot complete a Microsoft callback (and vice versa).
    expect(() =>
      validatePendingAuthorization(row, {
        userId: "u1",
        workspaceId: "w1",
        providerKey: "google",
        now,
      }),
    ).toThrow();
    expect(() =>
      validatePendingAuthorization(null, {
        userId: "u1",
        workspaceId: "w1",
        providerKey: "microsoft",
        now,
      }),
    ).toThrow(/expired|already used/);
  });

  it("exchanges the code server-side with the verifier and the client secret", async () => {
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      json({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        scope:
          "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send User.Read openid profile",
      }),
    );
    const tokens = await exchangeCode(
      config,
      { code: "the-code", codeVerifier: "verifier", scopes: scopesFor(["email"]) },
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const body = new URLSearchParams(String(init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe("verifier");
    expect(body.get("client_secret")).toBe("server-secret");
    expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    // Graph echoes scopes with its resource prefix: still recognized.
    expect(grantedCapabilities(tokens.scopes)).toEqual(["email"]);
    expect(grantedCapabilities(["Mail.ReadWrite", "User.Read"])).toEqual([]);
  });

  it("keeps the rotated refresh token, and the previous one when none comes back", async () => {
    const rotated = await refreshAccessToken(config, "rt-1", ["Mail.ReadWrite"], async () =>
      json({
        access_token: "at-2",
        refresh_token: "rt-2",
        expires_in: 3600,
        scope: "Mail.ReadWrite",
      }),
    );
    expect(credentialFromTokens(rotated, null).refreshToken).toBe("rt-2");
    const same = await refreshAccessToken(config, "rt-1", ["Mail.ReadWrite"], async () =>
      json({ access_token: "at-3", expires_in: 3600 }),
    );
    const previous = {
      accessToken: "at-2",
      accessTokenExpiresAt: "x",
      refreshToken: "rt-2",
      scopes: ["Mail.ReadWrite"],
    };
    expect(credentialFromTokens(same, previous)).toMatchObject({
      accessToken: "at-3",
      refreshToken: "rt-2",
      scopes: ["Mail.ReadWrite"],
    });
  });

  it("tells apart expired, revoked, consent withdrawn, conditional access and admin consent", () => {
    expect(microsoftAuthReason({ error: "invalid_grant", codes: [700082] })).toBe("expired");
    expect(microsoftAuthReason({ error: "invalid_grant", codes: [50173] })).toBe("expired");
    expect(microsoftAuthReason({ error: "invalid_grant" })).toBe("revoked");
    expect(microsoftAuthReason({ error: "invalid_grant", codes: [65001] })).toBe("consent_revoked");
    expect(microsoftAuthReason({ error: "interaction_required", codes: [53003] })).toBe(
      "conditional_access",
    );
    expect(
      microsoftAuthReason({
        error: "access_denied",
        description: "AADSTS90094: Admin consent is required.",
      }),
    ).toBe("admin_consent_required");
    expect(microsoftAuthReason({ error: "access_denied" })).toBe("cancelled");
    expect(microsoftAuthReason({ error: "invalid_client", codes: [7000222] })).toBe(
      "client_misconfigured",
    );

    expect(authError("expired")).toMatchObject({ code: "AUTH_EXPIRED", recovery: "reconnect" });
    expect(authError("conditional_access")).toMatchObject({
      code: "AUTH_EXPIRED",
      details: { reason: "conditional_access" },
    });
    expect(authError("admin_consent_required")).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(authError("cancelled")).toMatchObject({ code: "PERMISSION_DENIED", recovery: "retry" });
    // Our own misconfiguration is never shown as the user's account being disconnected.
    expect(authError("client_misconfigured")).toMatchObject({ code: "SERVER_NOT_CONFIGURED" });
  });

  it("maps token endpoint failures without leaking Microsoft's description", async () => {
    const refused = refreshAccessToken(config, "rt", [], async () =>
      json(
        {
          error: "invalid_grant",
          error_codes: [70008],
          error_description: "AADSTS70008: token for user leo@firbot.com expired. Trace ID: abc",
        },
        400,
      ),
    );
    await expect(refused).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      details: { reason: "expired" },
    });
    await expect(refused).rejects.not.toHaveProperty("message", expect.stringContaining("leo@"));
    await expect(
      refreshAccessToken(config, "rt", [], async () => json({}, 503)),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("identity: the stable Graph id is the key; mail falls back to the UPN", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        id: "graph-id-1",
        displayName: "Leo",
        mail: null,
        userPrincipalName: "leo@firbot.com",
      }),
    );
    expect(await fetchIdentity("at", fetchImpl)).toEqual({
      id: "graph-id-1",
      email: "leo@firbot.com",
      name: "Leo",
    });
    await expect(fetchIdentity("at", async () => json({}, 401))).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(suggestAlias("leo@outlook.com")).toBe("Personal");
    expect(suggestAlias("leo@hotmail.com")).toBe("Personal");
    expect(suggestAlias("leo@firbot.com")).toBe("Firbot");
  });
});

describe("Microsoft tokens", () => {
  const ref = { connectionId: "c1", workspaceId: "w1" };

  it("refreshes with Microsoft and marks the account with the precise reason when refused", async () => {
    const vault = new MemoryVault({
      accessToken: "old",
      accessTokenExpiresAt: "2020-01-01T00:00:00Z",
      refreshToken: "rt",
      scopes: ["Mail.ReadWrite"],
    });
    const onReauthorizationRequired = vi.fn(async () => {});
    const tokens = new GoogleTokenProvider(ref, {
      vault,
      providerName: "Microsoft",
      onReauthorizationRequired,
      refresh: (rt) =>
        refreshAccessToken(config, rt, ["Mail.ReadWrite"], async () =>
          json({ error: "interaction_required", error_codes: [53003] }, 400),
        ),
    });
    await expect(tokens.accessToken()).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      message: "This Microsoft account needs to be reconnected",
    });
    expect(onReauthorizationRequired).toHaveBeenCalledWith(ref, "conditional_access");
  });

  it("stores the rotated refresh token after a refresh", async () => {
    const vault = new MemoryVault({
      accessToken: "old",
      accessTokenExpiresAt: "2020-01-01T00:00:00Z",
      refreshToken: "rt-1",
      scopes: ["Mail.ReadWrite"],
    });
    const tokens = new GoogleTokenProvider(ref, {
      vault,
      providerName: "Microsoft",
      onReauthorizationRequired: vi.fn(),
      refresh: async () => ({
        accessToken: "new",
        refreshToken: "rt-2",
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: [],
      }),
    });
    expect(await tokens.accessToken()).toBe("new");
    expect(vault.value).toMatchObject({ refreshToken: "rt-2", scopes: ["Mail.ReadWrite"] });
  });
});

describe("GraphHttp", () => {
  const tokens = { accessToken: async () => "t" };

  it("retries once with a fresh token after a 401", async () => {
    const t = { accessToken: vi.fn(async (force?: boolean) => (force ? "fresh" : "stale")) };
    const http = new GraphHttp(t, {
      fetchImpl: async (_u, init) =>
        (init?.headers as Record<string, string>).authorization === "Bearer fresh"
          ? json({ ok: true })
          : json({}, 401),
    });
    expect(await http.request("GET", "https://graph")).toEqual({ ok: true });
    expect(t.accessToken).toHaveBeenLastCalledWith(true);
  });

  it("honours Retry-After on throttling, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const http = new GraphHttp(tokens, {
      sleep,
      fetchImpl: async () =>
        ++calls === 1
          ? json({ error: { code: "TooManyRequests" } }, 429, { "retry-after": "2" })
          : json({ v: 1 }),
    });
    expect(await http.request("GET", "u")).toEqual({ v: 1 });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("persistent throttling is RATE_LIMITED — never a reason to reconnect", async () => {
    const onUnauthorized = vi.fn(async () => {});
    const http = new GraphHttp(tokens, {
      sleep: async () => {},
      onUnauthorized,
      fetchImpl: async () => json({ error: { code: "ApplicationThrottled" } }, 429),
    });
    await expect(http.request("POST", "u", {})).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(onUnauthorized).not.toHaveBeenCalled();
    // A long Retry-After is not waited out inside a request.
    const sleep = vi.fn(async () => {});
    const busy = new GraphHttp(tokens, {
      sleep,
      fetchImpl: async () => json({}, 429, { "retry-after": "120" }),
    });
    await expect(busy.request("GET", "u")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(sleep).not.toHaveBeenCalled();
    expect(retryDelay(json({}, 429), 2)).toBe(2000);
  });

  it("never retries or claims an unconfirmed write", async () => {
    const fetchImpl = vi.fn(async () => json({}, 503));
    const http = new GraphHttp(tokens, { sleep: async () => {}, fetchImpl });
    await expect(http.request("POST", "u/send")).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const timeout = new GraphHttp(tokens, {
      fetchImpl: async () => {
        throw new DOMException("timeout", "TimeoutError");
      },
    });
    await expect(timeout.request("POST", "u/send")).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
    });
  });

  it("maps Graph errors to ELISE errors without raw messages", async () => {
    const status = (code: number, body: unknown, headers: Record<string, string> = {}) =>
      new GraphHttp(tokens, {
        sleep: async () => {},
        fetchImpl: async () => json(body, code, headers),
      });
    await expect(
      status(403, { error: { code: "ErrorAccessDenied", message: "secret detail" } }).request(
        "GET",
        "u",
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", recovery: "reconnect" });
    await expect(
      status(404, { error: { code: "MailboxNotEnabledForRESTAPI" } }).request("GET", "u"),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(
      status(404, { error: { code: "ErrorItemNotFound" } }).request("GET", "u"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      status(404, {}).request("GET", "u", undefined, { notFoundAsNull: true }),
    ).resolves.toBeNull();
    const error = await status(403, {
      error: { code: "ErrorAccessDenied", message: "secret detail" },
    })
      .request("GET", "u")
      .catch((e: Error) => e);
    expect(JSON.stringify(error)).not.toContain("secret detail");
  });

  it("a Conditional Access challenge marks the account for reconnection with that reason", async () => {
    const onUnauthorized = vi.fn(async () => {});
    const http = new GraphHttp(tokens, {
      onUnauthorized,
      fetchImpl: async () =>
        json({}, 401, { "www-authenticate": 'Bearer error="insufficient_claims", claims="x"' }),
    });
    await expect(http.request("GET", "u")).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      details: { reason: "conditional_access" },
    });
    expect(onUnauthorized).toHaveBeenCalledWith("conditional_access");
  });

  it("keeps at most 4 requests in flight per mailbox", async () => {
    let active = 0;
    let peak = 0;
    const http = new GraphHttp(tokens, {
      fetchImpl: async () => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return json({ ok: true });
      },
    });
    await Promise.all(Array.from({ length: 12 }, () => http.request("GET", "u")));
    expect(peak).toBe(4);
  });
});
