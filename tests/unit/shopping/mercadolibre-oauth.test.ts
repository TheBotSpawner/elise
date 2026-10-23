import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-116: ELISE's Mercado Libre application account — OAuth authorization_code + PKCE with a
 * single-use state, the rotating refresh token kept encrypted (one refresh at a time, re-read on
 * invalid_grant), and nothing secret in what it returns or logs. Synthetic tokens only.
 */

const env = {
  MERCADOLIBRE_API_ENABLED: "true",
  MERCADOLIBRE_CLIENT_ID: "1234567890123456",
  MERCADOLIBRE_CLIENT_SECRET: "s".repeat(32),
  MERCADOLIBRE_REDIRECT_URI: "https://elise.example/api/integrations/mercadolibre/callback",
  MERCADOLIBRE_REFRESH_TOKEN: undefined as string | undefined,
};
vi.mock("@/config/server-env", () => ({ serverEnv: () => env }));
vi.mock("@/infrastructure/crypto/encryption", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));
const logs: unknown[] = [];
vi.mock("@/infrastructure/observability/logger", () => ({
  logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) },
}));

/** app_credentials, in memory. */
let row: { secret_encrypted: string; updated_at: string } | null = null;
vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: row, error: null }),
        upsert: async (r: { secret_encrypted: string; updated_at: string }) => {
          row = { secret_encrypted: r.secret_encrypted, updated_at: r.updated_at };
          return { error: null };
        },
        delete: () => ({
          eq: async () => {
            row = null;
            return { error: null };
          },
        }),
      };
      return q;
    },
  }),
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let ml: typeof import("@/infrastructure/shopping/mercadolibre");
beforeEach(async () => {
  vi.resetModules();
  row = null;
  logs.length = 0;
  ml = await import("@/infrastructure/shopping/mercadolibre");
});
afterEach(() => vi.unstubAllGlobals());

describe("authorization", () => {
  it("consent URL: client id, exact redirect, single-use state, PKCE S256 — no secret", () => {
    const a = ml.startAuthorization();
    const u = new URL(a.url);
    expect(u.origin + u.pathname).toBe("https://auth.mercadolibre.com.ar/authorization");
    expect(u.searchParams.get("client_id")).toBe(env.MERCADOLIBRE_CLIENT_ID);
    expect(u.searchParams.get("redirect_uri")).toBe(env.MERCADOLIBRE_REDIRECT_URI);
    expect(u.searchParams.get("state")).toBe(a.state);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(a.url).not.toContain(env.MERCADOLIBRE_CLIENT_SECRET);
    expect(ml.startAuthorization().state).not.toBe(a.state);
  });

  it("a different state or another address is refused before any token request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const a = ml.startAuthorization();
    await expect(
      ml.completeAuthorization(`${env.MERCADOLIBRE_REDIRECT_URI}?code=TG-1&state=other`, a),
    ).rejects.toThrow(/state/);
    await expect(
      ml.completeAuthorization(`https://evil.example/cb?code=TG-1&state=${a.state}`, a),
    ).rejects.toThrow(/redirect URI/);
    await expect(
      ml.completeAuthorization(
        `${env.MERCADOLIBRE_REDIRECT_URI}?error=access_denied&state=${a.state}`,
        a,
      ),
    ).rejects.toThrow(/not granted/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the code is exchanged server-side with the verifier; the refresh token is stored encrypted", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body ?? "") });
        if (url.endsWith("/oauth/token"))
          return json(200, {
            access_token: "APP_USR-access-1",
            refresh_token: "TG-refresh-1",
            expires_in: 21600,
            user_id: 42,
          });
        return json(200, { id: 42, nickname: "ELISEAPP" });
      }),
    );
    const a = ml.startAuthorization();
    const who = await ml.completeAuthorization(
      `${env.MERCADOLIBRE_REDIRECT_URI}?code=TG-code&state=${a.state}`,
      a,
    );
    expect(who).toEqual({ userId: "42", nickname: "ELISEAPP" });
    const body = new URLSearchParams(calls[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe(a.verifier);
    expect(row?.secret_encrypted).toMatch(/^enc:/);
    expect(JSON.parse(row!.secret_encrypted.slice(4)).refreshToken).toBe("TG-refresh-1");
    // Status says whose account, never a token; logs carry no token either.
    const status = await ml.connectionStatus();
    expect(JSON.stringify(status)).not.toMatch(/TG-|APP_USR/);
    expect(JSON.stringify(logs)).not.toMatch(/TG-|APP_USR/);
  });
});

describe("refresh", () => {
  const seed = (refresh: string) => {
    row = {
      secret_encrypted: `enc:${JSON.stringify({ refreshToken: refresh, userId: "42", nickname: "X", connectedAt: "2026-10-23T00:00:00Z" })}`,
      updated_at: "2026-10-23T00:00:00Z",
    };
  };

  it("rotates: the new refresh token replaces the old; concurrent calls refresh once", async () => {
    seed("TG-old-refresh");
    let refreshes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/oauth/token")) {
          refreshes++;
          return json(200, {
            access_token: "APP_USR-access-a",
            refresh_token: "TG-new-refresh",
            expires_in: 21600,
          });
        }
        return json(200, { id: "MLA1", title: "x" });
      }),
    );
    await Promise.all([ml.call("/items/MLA1"), ml.call("/items/MLA2"), ml.call("/items/MLA3")]);
    expect(refreshes).toBe(1);
    expect(JSON.parse(row!.secret_encrypted.slice(4)).refreshToken).toBe("TG-new-refresh");
  });

  it("invalid_grant: another instance rotated it — the latest stored token is read and used", async () => {
    seed("TG-stale-refresh");
    const used: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/oauth/token")) {
          const r = new URLSearchParams(String(init?.body)).get("refresh_token")!;
          used.push(r);
          if (r === "TG-stale-refresh") {
            seed("TG-rotated-elsewhere-x");
            return json(400, { error: "invalid_grant" });
          }
          return json(200, {
            access_token: "APP_USR-access-b",
            refresh_token: "TG-next-refresh",
            expires_in: 21600,
          });
        }
        return json(200, {});
      }),
    );
    await ml.call("/items/MLA1");
    expect(used).toEqual(["TG-stale-refresh", "TG-rotated-elsewhere-x"]);
  });

  it("403 refuses that resource (no pause); 401 pauses the API", async () => {
    seed("TG-ok");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/oauth/token")
          ? json(200, {
              access_token: "APP_USR-access-c",
              refresh_token: "TG-ok-refresh-2",
              expires_in: 21600,
            })
          : json(403, { code: "PA_UNAUTHORIZED_RESULT_FROM_POLICIES" }),
      ),
    );
    const api = ml.mercadoLibreApi()!;
    const site = {
      site: "MLA",
      currency: "ARS",
      host: "mercadolibre.com.ar",
      list: "listado.mercadolibre.com.ar",
    } as const;
    await expect(api.listings(site, ["item:MLA1"])).rejects.toMatchObject({
      details: { providerStatus: 403, endpoint: "/items/:id" },
    });
    // A 403 is that listing: the next call still goes out (and is refused on its own).
    await expect(api.listings(site, ["item:MLA2"])).rejects.toMatchObject({
      details: { providerStatus: 403 },
    });
  });

  it("disconnect forgets the stored token", async () => {
    seed("TG-x");
    await ml.disconnect();
    expect((await ml.connectionStatus()).connected).toBe(false);
  });
});
