import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: vi.fn(async () => "vercel-oidc-jwt") }));
const env = vi.hoisted(() => ({ value: {} as Record<string, string | undefined> }));
vi.mock("@/config/server-env", () => ({ serverEnv: () => env.value }));
vi.mock("@/infrastructure/observability/usage", () => ({ recordUsage: vi.fn() }));

const PROCESSOR = "projects/p/locations/us/processors/abc";
const FEDERATION = {
  GCP_PROJECT_NUMBER: "123456789",
  GCP_WORKLOAD_IDENTITY_POOL_ID: "vercel",
  GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID: "vercel",
  GCP_SERVICE_ACCOUNT_EMAIL: "elise-document-ocr@proj.iam.gserviceaccount.com",
};
const SECRET = "test-broker-secret-0123456789abcdef";

/** Google answers: STS, impersonation, then Document AI; records what was asked. */
function google() {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith("https://sts.googleapis.com"))
        return Response.json({ access_token: "federated" });
      if (url.includes("iamcredentials"))
        return Response.json({
          accessToken: "sa-token",
          expireTime: new Date(Date.now() + 3600_000).toISOString(),
        });
      if (url.includes("/api/internal/ocr-token"))
        return Response.json({ accessToken: "brokered", expiresAt: Date.now() + 3600_000 });
      return Response.json({ document: { text: "Hola", pages: [] } });
    }),
  );
  return calls;
}

async function load() {
  vi.resetModules();
  return import("@/infrastructure/ocr/google-document-ai");
}

const ocrOnce = async (provider: { ocr: (i: never) => Promise<unknown> } | null) =>
  provider!.ocr({ data: new Uint8Array([1]), mimeType: "image/png", pages: null } as never);

beforeEach(() => {
  env.value = { GOOGLE_DOCUMENT_AI_PROCESSOR: PROCESSOR };
  // Running on Vercel (its functions get the OIDC token); tests off Vercel unset it.
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OCR without keys (ADR-121)", () => {
  it("nothing configured: no OCR (scanned pages are reported, not guessed)", async () => {
    const { getOcrProvider } = await load();
    expect(getOcrProvider()).toBeNull();
  });

  it("on Vercel: Vercel's OIDC token → STS → the OCR account's token → Document AI", async () => {
    env.value = { ...env.value, ...FEDERATION };
    const calls = google();
    const { getOcrProvider } = await load();
    await ocrOnce(getOcrProvider() as never);

    const sts = JSON.parse(String(calls[0]!.init.body));
    expect(sts.subjectToken).toBe("vercel-oidc-jwt");
    expect(sts.audience).toBe(
      "//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/vercel/providers/vercel",
    );
    expect(calls[1]!.url).toContain(
      "serviceAccounts/elise-document-ocr%40proj.iam.gserviceaccount.com:generateAccessToken",
    );
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer federated");
    expect(new Headers(calls[2]!.init.headers).get("authorization")).toBe("Bearer sa-token");
  });

  it("reuses the one-hour token instead of exchanging on every page", async () => {
    env.value = { ...env.value, ...FEDERATION };
    const calls = google();
    const { getOcrProvider } = await load();
    await ocrOnce(getOcrProvider() as never);
    await ocrOnce(getOcrProvider() as never);
    expect(calls.filter((c) => c.url.startsWith("https://sts")).length).toBe(1);
  });

  it("in background jobs: a signed request to ELISE's broker, never a key", async () => {
    env.value = {
      ...env.value,
      OCR_TOKEN_BROKER_URL: "https://elise.example.org/api/internal/ocr-token",
      OCR_BROKER_SECRET: SECRET,
    };
    const calls = google();
    const { getOcrProvider, verifyBrokerRequest } = await load();
    await ocrOnce(getOcrProvider() as never);
    const headers = new Headers(calls[0]!.init.headers);
    expect(
      verifyBrokerRequest(SECRET, headers.get("x-elise-at"), headers.get("x-elise-signature")),
    ).toBe(true);
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer brokered");
  });

  it("off Vercel the GCP_* identifiers are ignored: Trigger.dev uses the broker even when they were synced", async () => {
    vi.stubEnv("VERCEL", "");
    env.value = {
      ...env.value,
      ...FEDERATION,
      OCR_TOKEN_BROKER_URL: "https://elise.example.org/api/internal/ocr-token",
      OCR_BROKER_SECRET: SECRET,
    };
    const calls = google();
    const { getOcrProvider, ocrAuthMode } = await load();
    expect(ocrAuthMode()).toBe("broker");
    await ocrOnce(getOcrProvider() as never);
    expect(calls[0]!.url).toBe("https://elise.example.org/api/internal/ocr-token");
    expect(calls.some((c) => c.url.startsWith("https://sts"))).toBe(false);
  });

  it("a missing Vercel token or an unreachable broker is a typed error, never 'Unexpected error'", async () => {
    const oidc = await import("@vercel/oidc");
    vi.mocked(oidc.getVercelOidcToken).mockRejectedValueOnce(new Error("header missing"));
    env.value = { ...env.value, ...FEDERATION };
    google();
    let mod = await load();
    await expect(ocrOnce(mod.getOcrProvider() as never)).rejects.toMatchObject({
      code: "AI_NOT_CONFIGURED",
    });

    vi.stubEnv("VERCEL", "");
    env.value = {
      GOOGLE_DOCUMENT_AI_PROCESSOR: PROCESSOR,
      OCR_TOKEN_BROKER_URL: "https://elise.example.org/api/internal/ocr-token",
      OCR_BROKER_SECRET: SECRET,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    mod = await load();
    await expect(ocrOnce(mod.getOcrProvider() as never)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });

  it("the broker refuses a wrong secret, a forged signature and an old request", async () => {
    const { signBrokerRequest, verifyBrokerRequest } = await load();
    const now = Date.now();
    const signed = signBrokerRequest(SECRET, now);
    const at = signed["x-elise-at"];
    const sig = signed["x-elise-signature"];
    expect(verifyBrokerRequest(SECRET, at, sig, now)).toBe(true);
    expect(verifyBrokerRequest("other", at, sig, now)).toBe(false);
    expect(verifyBrokerRequest(SECRET, at, `${sig}x`, now)).toBe(false);
    expect(verifyBrokerRequest(SECRET, at, sig, now + 61_000)).toBe(false);
    expect(verifyBrokerRequest(SECRET, null, sig, now)).toBe(false);
  });

  it("the broker endpoint answers 401 without a valid signature", async () => {
    env.value = { ...env.value, ...FEDERATION, OCR_BROKER_SECRET: SECRET };
    vi.resetModules();
    const { POST } = await import("@/app/api/internal/ocr-token/route");
    const res = await POST(
      new Request("https://elise.example.org/api/internal/ocr-token", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  it("a signed request gets the federated token; the broker reuses it instead of asking Google again", async () => {
    env.value = { ...env.value, ...FEDERATION, OCR_BROKER_SECRET: SECRET };
    const calls = google();
    vi.resetModules();
    const { POST } = await import("@/app/api/internal/ocr-token/route");
    const { signBrokerRequest, ocrAuthMode } =
      await import("@/infrastructure/ocr/google-document-ai");
    const ask = () =>
      POST(
        new Request("https://elise.example.org/api/internal/ocr-token", {
          method: "POST",
          headers: signBrokerRequest(SECRET),
        }),
      );
    const first = await ask();
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect((await first.json()).accessToken).toBe("sa-token");
    expect((await ask()).status).toBe(200);
    expect(calls.filter((c) => c.url.startsWith("https://sts")).length).toBe(1);
    expect(ocrAuthMode()).toBe("federation");
  });

  it("the Supabase key never signs broker requests: without OCR_BROKER_SECRET there is no broker", async () => {
    env.value = {
      ...env.value,
      OCR_TOKEN_BROKER_URL: "https://elise.example.org/api/internal/ocr-token",
      SUPABASE_SECRET_KEY: "sb_secret_something_long_enough_here",
    };
    const { getOcrProvider, ocrAuthMode } = await load();
    expect(getOcrProvider()).toBeNull();
    expect(ocrAuthMode()).toBeNull();
  });
});
