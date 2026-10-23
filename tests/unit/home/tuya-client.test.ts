import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-118/119: Tuya's cloud client against a fake Tuya (no network): the documented signature,
 * OAuth code exchange and refresh in the account's own data center, a refused token refreshed
 * once, and how refusals, wrong data centers, quotas and rate limits are told apart and paused.
 * Mocks only — not a test against Tuya.
 */

vi.mock("server-only", () => ({}));
const env = vi.hoisted(() => ({
  TUYA_ENABLED: "true",
  TUYA_CLIENT_ID: "client123",
  TUYA_CLIENT_SECRET: "secret456",
  TUYA_REGION: "us",
}));
vi.mock("@/config/server-env", () => ({ serverEnv: () => env }));

const {
  classifyTuya,
  exchangeTuyaCode,
  forgetTuyaAccount,
  projectAuth,
  refreshTuyaToken,
  resetTuyaForTests,
  tuyaSendAc,
  tuyaSendKey,
  tuyaSign,
  tuyaUserDevices,
} = await import("@/infrastructure/home/tuya");

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
let calls: Call[];
let answers: ((c: Call) => { status?: number; json: unknown })[];

beforeEach(() => {
  resetTuyaForTests();
  calls = [];
  answers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const c: Call = {
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        ...(typeof init.body === "string" ? { body: init.body } : {}),
      };
      calls.push(c);
      const next = answers.shift();
      if (!next) throw new Error(`unexpected call ${url}`);
      const a = next(c);
      return new Response(JSON.stringify(a.json), { status: a.status ?? 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const TOKEN = {
  success: true,
  result: {
    access_token: "access-aaa",
    refresh_token: "refresh-bbb",
    expire_time: 7200,
    uid: "uid-x",
  },
};
const ok = (result: unknown) => () => ({ json: { success: true, result } });

/** A person's token getter, as the application layer hands it in. */
function userAuth(region: "us" | "eu" = "us") {
  let token = "user-token-1";
  return {
    region,
    key: "conn-1",
    rejected: 0,
    async accessToken() {
      return token;
    },
    tokenRejected() {
      this.rejected++;
      token = "user-token-2";
    },
  };
}

describe("signature", () => {
  it("HMAC-SHA256 over client_id + token + t + nonce + stringToSign, upper-case", () => {
    const empty = createHash("sha256").update("").digest("hex");
    expect(empty).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const sign = tuyaSign({
      clientId: "c",
      secret: "s",
      accessToken: "tok",
      t: "1700000000000",
      nonce: "n",
      method: "GET",
      path: "/v1.0/users/u/devices",
      query: { page_size: "50", from: "home" },
    });
    // Query sorted by key; no signed headers (empty line).
    const expected = createHmac("sha256", "s")
      .update(`ctok1700000000000nGET\n${empty}\n\n/v1.0/users/u/devices?from=home&page_size=50`)
      .digest("hex")
      .toUpperCase();
    expect(sign).toBe(expected);
  });

  it("a token request has no access token; a body is hashed", () => {
    const body = JSON.stringify({ key: "power" });
    const a = tuyaSign({
      clientId: "c",
      secret: "s",
      t: "1",
      nonce: "n",
      method: "POST",
      path: "/p",
      body,
    });
    const hash = createHash("sha256").update(body).digest("hex");
    expect(a).toBe(
      createHmac("sha256", "s").update(`c1nPOST\n${hash}\n\n/p`).digest("hex").toUpperCase(),
    );
  });
});

describe("OAuth tokens (grant_type=2)", () => {
  it("exchanges the person's code in THEIR data center, without an access token", async () => {
    answers.push(() => ({ json: TOKEN }));
    const t = await exchangeTuyaCode("eu", "code-123");
    expect(calls[0]!.url).toBe("https://openapi.tuyaeu.com/v1.0/token?grant_type=2&code=code-123");
    expect(calls[0]!.headers.access_token).toBeUndefined();
    expect(t).toMatchObject({
      accessToken: "access-aaa",
      refreshToken: "refresh-bbb",
      uid: "uid-x",
    });
    expect(t.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7000_000);
  });

  it("refreshes with the refresh token's own path", async () => {
    answers.push(() => ({ json: TOKEN }));
    await refreshTuyaToken("us", "refresh-old");
    expect(calls[0]!.url).toBe("https://openapi.tuyaus.com/v1.0/token/refresh-old");
  });

  it("an account from another data center is told apart (not a generic failure)", async () => {
    answers.push(() => ({
      json: { success: false, code: 1106, msg: "Data centers inconsistency" },
    }));
    await expect(exchangeTuyaCode("us", "code-x")).rejects.toMatchObject({
      details: { tuyaProblem: "wrong_region" },
    });
  });

  it("classifies Tuya's answers into what the person can act on", () => {
    expect(classifyTuya(1010, 200)).toBe("token");
    expect(classifyTuya(1106, 200)).toBe("permission");
    expect(classifyTuya(28841105, 200)).toBe("permission");
    expect(classifyTuya(null, 429)).toBe("rate_limited");
    expect(classifyTuya(28841002, 200, "the API quota is exceeded")).toBe("quota");
    expect(classifyTuya(1004, 200)).toBe("project");
  });
});

describe("calls with the person's token", () => {
  it("signs with their token, in their data center, and never sends the secret", async () => {
    answers.push(
      ok([{ id: "dev_ir_01", name: "IR", category: "wnykq", online: true, sub: false }]),
    );
    const auth = userAuth("eu");
    const list = await tuyaUserDevices(auth, "uid-1");
    expect(list).toEqual([
      { id: "dev_ir_01", name: "IR", category: "wnykq", online: true, sub: false },
    ]);
    expect(calls[0]!.url).toBe("https://openapi.tuyaeu.com/v1.0/users/uid-1/devices");
    expect(calls[0]!.headers).toMatchObject({
      client_id: "client123",
      sign_method: "HMAC-SHA256",
      access_token: "user-token-1",
    });
    expect(calls[0]!.headers.t).toMatch(/^\d{13}$/);
    expect(calls[0]!.headers.sign).toMatch(/^[0-9A-F]{64}$/);
    expect(JSON.stringify(calls)).not.toContain("secret456");
  });

  it("a refused token (1010) is refreshed once, then the call retried", async () => {
    answers.push(() => ({ json: { success: false, code: 1010, msg: "token invalid" } }), ok([]));
    const auth = userAuth();
    await expect(tuyaUserDevices(auth, "uid-2")).resolves.toEqual([]);
    expect(auth.rejected).toBe(1);
    expect(calls[1]!.headers.access_token).toBe("user-token-2");
  });

  it("a permission refusal (IR service not enabled) says so and doesn't pause the account", async () => {
    answers.push(() => ({ json: { success: false, code: 1106, msg: "permission deny" } }), ok([]));
    const auth = userAuth();
    await expect(tuyaUserDevices(auth, "uid-3")).rejects.toMatchObject({
      details: { tuyaProblem: "permission" },
    });
    await expect(tuyaUserDevices(auth, "uid-4")).resolves.toEqual([]);
  });

  it("a rate limit pauses that account only", async () => {
    answers.push(() => ({ status: 429, json: { success: false } }), ok([]));
    const a = userAuth();
    await expect(tuyaUserDevices(a, "uid-5")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(tuyaUserDevices(a, "uid-6")).rejects.toMatchObject({
      message: "Smart Life is paused",
    });
    const b = { ...userAuth(), key: "conn-2" };
    await expect(tuyaUserDevices(b, "uid-7")).resolves.toEqual([]);
  });

  it("lists are cached per account and forgotten on disconnect", async () => {
    answers.push(ok([]), ok([]));
    const auth = userAuth();
    await tuyaUserDevices(auth, "uid-9");
    await tuyaUserDevices(auth, "uid-9");
    expect(calls).toHaveLength(1);
    forgetTuyaAccount("conn-1");
    await tuyaUserDevices(auth, "uid-9");
    expect(calls).toHaveLength(2);
  });

  it("the project token (local script) is asked once and reused", async () => {
    answers.push(() => ({ json: TOKEN }), ok([]), ok([]));
    const auth = projectAuth("us");
    await tuyaUserDevices(auth, "uid-a");
    await tuyaUserDevices(auth, "uid-b");
    expect(calls[0]!.url).toBe("https://openapi.tuyaus.com/v1.0/token?grant_type=1");
    expect(calls.filter((c) => c.url.includes("/v1.0/token"))).toHaveLength(1);
  });
});

describe("commands", () => {
  it("a standard key goes to /command; a learned remote's to /raw/command with its key id", async () => {
    answers.push(ok(true), ok(true));
    const auth = userAuth();
    await tuyaSendKey(auth, {
      infraredId: "ir_1",
      remoteId: "rm_1",
      categoryId: 2,
      remoteIndex: 7,
      key: "Mute",
    });
    await tuyaSendKey(auth, {
      infraredId: "ir_1",
      remoteId: "rm_2",
      categoryId: 999,
      key: "k",
      keyId: 4,
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://openapi.tuyaus.com/v2.0/infrareds/ir_1/remotes/rm_1/command",
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ category_id: 2, key: "Mute", remote_index: 7 });
    expect(calls[1]!.url).toMatch(/remotes\/rm_2\/raw\/command$/);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ category_id: 999, key_id: 4, key: "k" });
  });

  it("an air conditioner's state goes as Tuya's numbers (scenes/command)", async () => {
    answers.push(ok(true));
    await tuyaSendAc(userAuth(), {
      infraredId: "ir_1",
      remoteId: "ac_1",
      categoryId: 5,
      power: true,
      mode: "heat",
      temp: 24,
      fan: "high",
    });
    expect(calls[0]!.url).toMatch(
      /\/v2\.0\/infrareds\/ir_1\/air-conditioners\/ac_1\/scenes\/command$/,
    );
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      power: 1,
      mode: 1,
      temp: 24,
      wind: 3,
      category_id: 5,
    });
  });
});
