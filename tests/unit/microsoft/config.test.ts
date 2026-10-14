import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Microsoft OAuth configuration (ADR-058): one resolver for availability, start, callback and
 * refresh; precise, value-free setup errors; the exact production redirect URI.
 */

const SECRET = "ms-secret-VALUE-never-logged";
const KEY = Buffer.alloc(32, 7).toString("base64");

function stubAll(over: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    MICROSOFT_OAUTH_CLIENT_ID: "11111111-2222-3333-4444-555555555555",
    MICROSOFT_OAUTH_CLIENT_SECRET: SECRET,
    MICROSOFT_OAUTH_TENANT: undefined,
    ELISE_ENCRYPTION_KEY: KEY,
    SUPABASE_SECRET_KEY: "sb_secret_value",
    NEXT_PUBLIC_APP_URL: "https://elise-lime.vercel.app",
    VERCEL_ENV: undefined,
    VERCEL_PROJECT_PRODUCTION_URL: undefined,
    ...over,
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v ?? "");
}

async function config() {
  return import("@/infrastructure/providers/microsoft/config");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("Microsoft configuration", () => {
  it("everything present → available, and the client settings resolve", async () => {
    stubAll();
    const c = await config();
    expect(c.isMicrosoftConfigured()).toBe(true);
    expect(c.getMicrosoftOAuthConfig()).toMatchObject({
      clientId: "11111111-2222-3333-4444-555555555555",
      tenant: "common",
      authority: "https://login.microsoftonline.com/common/oauth2/v2.0",
      redirectUri: "https://elise-lime.vercel.app/api/connections/microsoft/callback",
    });
  });

  it.each([
    [undefined, "common"],
    ["   ", "common"],
    ["common", "common"],
    ["organizations", "organizations"],
    ["consumers", "consumers"],
    ["9188040d-6c67-4c5b-b112-36a304b66dad", "tenant-id"],
    ["firbot.onmicrosoft.com", "tenant-id"],
  ])("tenant %j resolves as %s (no GUID required)", async (tenant, mode) => {
    stubAll({ MICROSOFT_OAUTH_TENANT: tenant });
    const c = await config();
    expect(c.microsoftSetup()).toMatchObject({ tenantMode: mode, ready: true });
  });

  it("a malformed tenant is a precise setup error, not a guess", async () => {
    stubAll({ MICROSOFT_OAUTH_TENANT: "not a tenant!" });
    const c = await config();
    expect(() => c.getMicrosoftOAuthConfig()).toThrow(
      expect.objectContaining({
        code: "SERVER_NOT_CONFIGURED",
        details: { setup: "microsoft_oauth", missing: ["MICROSOFT_OAUTH_TENANT"] },
      }),
    );
  });

  it.each([["MICROSOFT_OAUTH_CLIENT_ID"], ["MICROSOFT_OAUTH_CLIENT_SECRET"]])(
    "missing %s → a Microsoft setup error naming it",
    async (name) => {
      stubAll({ [name]: undefined });
      const c = await config();
      expect(c.isMicrosoftConfigured()).toBe(false);
      expect(() => c.getMicrosoftOAuthConfig()).toThrow(
        expect.objectContaining({
          code: "SERVER_NOT_CONFIGURED",
          details: { setup: "microsoft_oauth", missing: [name] },
        }),
      );
    },
  );

  it("a missing encryption key is the credential vault, reported apart from Microsoft", async () => {
    stubAll({ ELISE_ENCRYPTION_KEY: undefined });
    const c = await config();
    expect(c.microsoftSetup()).toMatchObject({
      missing: [],
      vaultMissing: ["ELISE_ENCRYPTION_KEY"],
      ready: false,
    });
    expect(() => c.getMicrosoftOAuthConfig()).toThrow(
      expect.objectContaining({
        details: { setup: "credential_vault", missing: ["ELISE_ENCRYPTION_KEY"] },
      }),
    );
  });

  it("unrelated infrastructure never blocks Microsoft (OpenAI, Trigger, Google…)", async () => {
    stubAll({
      OPENAI_API_KEY: undefined,
      TRIGGER_SECRET_KEY: undefined,
      GOOGLE_OAUTH_CLIENT_ID: undefined,
      NOTION_OAUTH_CLIENT_ID: undefined,
    });
    expect((await config()).isMicrosoftConfigured()).toBe(true);
  });

  it("values pasted with a trailing newline still work (env values are trimmed)", async () => {
    stubAll({ MICROSOFT_OAUTH_CLIENT_SECRET: `${SECRET}\n` });
    expect((await config()).getMicrosoftOAuthConfig().clientSecret).toBe(SECRET);
  });
});

describe("redirect URI", () => {
  it("production: exactly the registered URI, from NEXT_PUBLIC_APP_URL (never the request host)", async () => {
    stubAll();
    const c = await config();
    expect(c.microsoftRedirectUri("https://elise-abc123-firbot.vercel.app")).toBe(
      "https://elise-lime.vercel.app/api/connections/microsoft/callback",
    );
  });

  it("without NEXT_PUBLIC_APP_URL on Vercel Production: the production domain, not the deployment", async () => {
    stubAll({
      NEXT_PUBLIC_APP_URL: undefined,
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "elise-lime.vercel.app",
    });
    const c = await config();
    expect(c.microsoftRedirectUri("https://elise-git-main-firbot.vercel.app")).toBe(
      "https://elise-lime.vercel.app/api/connections/microsoft/callback",
    );
  });

  it("local development: the request origin", async () => {
    stubAll({ NEXT_PUBLIC_APP_URL: undefined });
    expect((await config()).microsoftRedirectUri("http://localhost:3000")).toBe(
      "http://localhost:3000/api/connections/microsoft/callback",
    );
  });
});

describe("authorization URL", () => {
  it("client id, code flow, exact redirect, query mode, identity + Graph mail scopes; no secret", async () => {
    stubAll();
    const c = await config();
    const { buildAuthorizationUrl, scopesFor } =
      await import("@/infrastructure/providers/microsoft/oauth");
    const url = new URL(
      buildAuthorizationUrl(c.getMicrosoftOAuthConfig(), {
        scopes: scopesFor(["email"]),
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "11111111-2222-3333-4444-555555555555",
      response_type: "code",
      response_mode: "query",
      redirect_uri: "https://elise-lime.vercel.app/api/connections/microsoft/callback",
      scope: "openid profile offline_access User.Read Mail.ReadWrite Mail.Send",
    });
    expect(url.toString()).not.toContain(SECRET);
  });
});

describe("diagnostics and logs", () => {
  it("diagnostics are booleans and safe metadata only", async () => {
    stubAll({ MICROSOFT_OAUTH_TENANT: "9188040d-6c67-4c5b-b112-36a304b66dad" });
    const d = (await config()).microsoftDiagnostics();
    const text = JSON.stringify(d);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("11111111-2222");
    expect(text).not.toContain("9188040d");
    expect(text).not.toContain(KEY);
    expect(d).toMatchObject({
      ready: true,
      clientIdPresent: true,
      clientSecretPresent: true,
      tenant: { configured: true, mode: "tenant-id" },
      vault: { ready: true },
      redirectUri: "https://elise-lime.vercel.app/api/connections/microsoft/callback",
      appUrlSource: "NEXT_PUBLIC_APP_URL",
    });
  });

  it("the start log says what is missing by name, never a value", async () => {
    stubAll({ MICROSOFT_OAUTH_CLIENT_ID: undefined });
    const { logger } = await import("@/infrastructure/observability/logger");
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    const { startMicrosoftConnection } = await import("@/application/connections-service");
    const auth = { userId: "u-log", workspaceId: "w", db: {} } as never;
    await expect(startMicrosoftConnection(auth, { origin: "https://x" })).rejects.toMatchObject({
      code: "SERVER_NOT_CONFIGURED",
      details: { setup: "microsoft_oauth", missing: ["MICROSOFT_OAUTH_CLIENT_ID"] },
    });
    expect(info).toHaveBeenCalledWith(
      "microsoft.oauth.start",
      expect.objectContaining({ configured: false, missing: ["MICROSOFT_OAUTH_CLIENT_ID"] }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(SECRET);
    // A fresh import of the whole connections service: slow under a full parallel run.
  }, 30_000);
});

describe("one resolver", () => {
  it("only microsoft/config.ts reads the MICROSOFT_OAUTH_* settings", () => {
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && /\.MICROSOFT_OAUTH_/.test(readFileSync(path, "utf8")))
          readers.push(path.replaceAll("\\", "/"));
      }
    };
    walk("src");
    expect(readers).toEqual(["src/infrastructure/providers/microsoft/config.ts"]);
  });

  it("the Connections card and the OAuth start agree: unavailable ⇔ start refuses", async () => {
    stubAll({ MICROSOFT_OAUTH_CLIENT_SECRET: undefined });
    const c = await config();
    expect(c.isMicrosoftConfigured()).toBe(false);
    expect(() => c.getMicrosoftOAuthConfig()).toThrow();
    vi.resetModules();
    stubAll();
    const ok = await config();
    expect(ok.isMicrosoftConfigured()).toBe(true);
    expect(() => ok.getMicrosoftOAuthConfig()).not.toThrow();
  });
});
