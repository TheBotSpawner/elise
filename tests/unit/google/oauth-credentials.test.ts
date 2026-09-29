import { describe, expect, it, vi } from "vitest";

import {
  parseRequestedCapabilities,
  validatePendingAuthorization,
} from "@/application/connections-service";
import { AppError } from "@/core/errors";
import {
  decrypt,
  encrypt,
  keyringFromEnv,
  needsRotation,
} from "@/infrastructure/crypto/encryption";
import {
  GoogleTokenProvider,
  type CredentialVault,
  type StoredCredential,
} from "@/infrastructure/providers/google/credentials";
import { GoogleHttp } from "@/infrastructure/providers/google/http";
import {
  buildAuthorizationUrl,
  createPkce,
  createState,
  exchangeCode,
  grantedCapabilities,
  hashState,
  refreshAccessToken,
  scopesFor,
  suggestAlias,
} from "@/infrastructure/providers/google/oauth";

const config = {
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "http://localhost:3000/api/connections/google/callback",
};
const KEY = Buffer.alloc(32, 7).toString("base64");
const OLD_KEY = Buffer.alloc(32, 9).toString("base64");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("progressive Google authorization", () => {
  it("requests only identity + the chosen capabilities, offline, incremental, with PKCE", () => {
    const pkce = createPkce();
    const url = new URL(
      buildAuthorizationUrl(config, {
        scopes: scopesFor(["calendar"]),
        state: "s",
        codeChallenge: pkce.challenge,
      }),
    );
    const scopes = url.searchParams.get("scope")!.split(" ");
    expect(scopes).toEqual([
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect(scopes.join(" ")).not.toMatch(/gmail|drive|tasks/);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
  });

  it("enables only capabilities whose scopes were actually granted", () => {
    expect(grantedCapabilities(scopesFor(["calendar", "tasks"]))).toEqual(["calendar", "tasks"]);
    // User unticked Tasks (granular consent) and half of Calendar.
    expect(
      grantedCapabilities(["openid", "https://www.googleapis.com/auth/calendar.readonly"]),
    ).toEqual([]);
    expect(grantedCapabilities(scopesFor(["tasks"]))).toEqual(["tasks"]);
  });

  it("uses single-use, hashed state", () => {
    const { state, hash } = createState();
    expect(hash).toBe(hashState(state));
    expect(hash).not.toContain(state);
    expect(createState().state).not.toBe(state);
  });

  it("only accepts Calendar and Tasks for this milestone", () => {
    expect(parseRequestedCapabilities(["calendar", "gmail", "tasks", "drive"])).toEqual([
      "calendar",
      "tasks",
    ]);
    expect(() => parseRequestedCapabilities(["gmail"])).toThrow(AppError);
  });

  it("suggests friendly aliases", () => {
    expect(suggestAlias("leo@gmail.com")).toBe("Personal");
    expect(suggestAlias("leo@firbot.com")).toBe("Firbot");
  });
});

describe("OAuth state validation", () => {
  const expected = {
    userId: "u1",
    workspaceId: "w1",
    providerKey: "google" as const,
    now: new Date("2026-09-29T12:00:00Z"),
  };
  const row = {
    user_id: "u1",
    workspace_id: "w1",
    provider_key: "google",
    expires_at: "2026-09-29T12:05:00Z",
  };

  it("accepts the same user, workspace and provider within the window", () => {
    expect(() => validatePendingAuthorization(row, expected)).not.toThrow();
  });
  it("rejects unknown/reused state, another user or workspace, and expiry", () => {
    expect(() => validatePendingAuthorization(null, expected)).toThrow(
      /expired or was already used/,
    );
    expect(() => validatePendingAuthorization({ ...row, user_id: "u2" }, expected)).toThrow(
      /another session/,
    );
    expect(() => validatePendingAuthorization({ ...row, workspace_id: "w2" }, expected)).toThrow(
      /another session/,
    );
    expect(() =>
      validatePendingAuthorization({ ...row, expires_at: "2026-09-29T11:59:00Z" }, expected),
    ).toThrow(/expired/);
  });
});

describe("token exchange and refresh", () => {
  it("exchanges the code with the PKCE verifier server-side", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code_verifier")).toBe("verifier");
      expect(body.get("client_secret")).toBe("secret");
      return json({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        scope: "openid https://www.googleapis.com/auth/tasks",
      });
    });
    const tokens = await exchangeCode(config, { code: "c", codeVerifier: "verifier" }, fetchImpl);
    expect(tokens).toMatchObject({
      accessToken: "at",
      refreshToken: "rt",
      scopes: ["openid", "https://www.googleapis.com/auth/tasks"],
    });
  });

  it("maps a revoked refresh token to AUTH_EXPIRED", async () => {
    const fetchImpl = async () => json({ error: "invalid_grant" }, 400);
    await expect(refreshAccessToken(config, "rt", fetchImpl)).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      recovery: "reconnect",
    });
  });
});

class MemoryVault implements CredentialVault {
  value: StoredCredential | null;
  constructor(value: StoredCredential | null) {
    this.value = value;
  }
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

describe("GoogleTokenProvider", () => {
  const ref = { connectionId: "c1", workspaceId: "w1" };
  const now = Date.parse("2026-09-29T12:00:00Z");

  it("reuses a valid token and refreshes one about to expire, keeping the refresh token", async () => {
    // Expires in 30 s: inside the refresh margin.
    const realNow = Date.now();
    const vault = new MemoryVault({
      accessToken: "old",
      accessTokenExpiresAt: new Date(realNow + 30_000).toISOString(),
      refreshToken: "rt",
      scopes: ["s"],
    });
    const fetchImpl = vi.fn(async () => json({ access_token: "new", expires_in: 3600 }));
    const tokens = new GoogleTokenProvider(ref, {
      vault,
      config,
      onReauthorizationRequired: vi.fn(),
      fetchImpl,
    });
    expect(await tokens.accessToken()).toBe("new");
    expect(vault.value).toMatchObject({ accessToken: "new", refreshToken: "rt", scopes: ["s"] });
    expect(await tokens.accessToken()).toBe("new");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("marks the connection for reauthorization when Google revoked access", async () => {
    const vault = new MemoryVault({
      accessToken: "old",
      accessTokenExpiresAt: "2026-09-29T11:00:00Z",
      refreshToken: "rt",
      scopes: [],
    });
    const onReauthorizationRequired = vi.fn(async () => {});
    const tokens = new GoogleTokenProvider(ref, {
      vault,
      config,
      onReauthorizationRequired,
      fetchImpl: async () => json({ error: "invalid_grant" }, 400),
      now: () => now,
    });
    await expect(tokens.accessToken()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(onReauthorizationRequired).toHaveBeenCalledWith(ref, "invalid_grant");
  });

  it("fails closed when credentials are missing", async () => {
    const onReauthorizationRequired = vi.fn(async () => {});
    const tokens = new GoogleTokenProvider(ref, {
      vault: new MemoryVault(null),
      config,
      onReauthorizationRequired,
    });
    await expect(tokens.accessToken()).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(onReauthorizationRequired).toHaveBeenCalled();
  });
});

describe("GoogleHttp", () => {
  it("retries once with a fresh token after a 401", async () => {
    const tokens = { accessToken: vi.fn(async (force?: boolean) => (force ? "fresh" : "stale")) };
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      return auth === "Bearer fresh" ? json({ ok: true }) : json({}, 401);
    });
    const http = new GoogleHttp(tokens, fetchImpl);
    expect(await http.request("GET", "https://x")).toEqual({ ok: true });
    expect(tokens.accessToken).toHaveBeenLastCalledWith(true);
  });

  it("translates Google errors and never claims an unconfirmed write", async () => {
    const tokens = { accessToken: async () => "t" };
    const status = (code: number, reason = "") =>
      new GoogleHttp(tokens, async () => json({ error: { errors: [{ reason }] } }, code));
    await expect(status(403, "insufficientPermissions").request("GET", "u")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      recovery: "reconnect",
    });
    await expect(status(429).request("GET", "u")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(status(404).request("GET", "u")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(status(503).request("GET", "u")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
    const timeout = new GoogleHttp(tokens, async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
    await expect(timeout.request("POST", "u", {})).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
    });
  });
});

describe("credential encryption", () => {
  const keyring = keyringFromEnv({ ELISE_ENCRYPTION_KEY: KEY });

  it("round-trips and binds ciphertext to its context", () => {
    const secret = JSON.stringify({ refreshToken: "rt-secret" });
    const sealed = encrypt(secret, "connection_secret:w1:c1", keyring);
    expect(sealed).not.toContain("rt-secret");
    expect(decrypt(sealed, "connection_secret:w1:c1", keyring)).toBe(secret);
    expect(() => decrypt(sealed, "connection_secret:w2:c1", keyring)).toThrow(/authentication/);
  });

  it("detects tampering", () => {
    const sealed = encrypt("x", "ctx", keyring);
    const parts = sealed.split(".");
    parts[4] = Buffer.from("y").toString("base64url");
    expect(() => decrypt(parts.join("."), "ctx", keyring)).toThrow();
  });

  it("supports key rotation", () => {
    const old = keyringFromEnv({ ELISE_ENCRYPTION_KEY: OLD_KEY });
    const sealed = encrypt("x", "ctx", old);
    const rotated = keyringFromEnv({
      ELISE_ENCRYPTION_KEY: KEY,
      ELISE_ENCRYPTION_KEY_PREVIOUS: OLD_KEY,
    });
    expect(decrypt(sealed, "ctx", rotated)).toBe("x");
    expect(needsRotation(sealed, rotated)).toBe(true);
  });

  it("refuses to run without a proper key", () => {
    expect(() => keyringFromEnv({})).toThrow(/ELISE_ENCRYPTION_KEY/);
    expect(() => keyringFromEnv({ ELISE_ENCRYPTION_KEY: "short" })).toThrow(/32 bytes/);
  });
});
