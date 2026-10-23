import { createHash, createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADR-118: Tuya's cloud client against a fake Tuya (no network): the documented signature, the
 * project token cached and asked again when refused, and how refusals and rate limits pause it.
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

const { resetTuyaForTests, tuyaSendAc, tuyaSendKey, tuyaSign, tuyaUserDevices } =
  await import("@/infrastructure/home/tuya");

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
  result: { access_token: "access-aaa", refresh_token: "refresh-bbb", expire_time: 7200, uid: "x" },
};
const ok = (result: unknown) => () => ({ json: { success: true, result } });

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

describe("token and calls", () => {
  it("asks the token once, signs the call with it, and sends the documented headers", async () => {
    answers.push(
      () => ({ json: TOKEN }),
      ok([{ id: "dev_ir_01", name: "IR", category: "wnykq", online: true, sub: false }]),
    );
    const list = await tuyaUserDevices("uid-1");
    expect(list).toEqual([
      { id: "dev_ir_01", name: "IR", category: "wnykq", online: true, sub: false },
    ]);
    expect(calls[0]!.url).toBe("https://openapi.tuyaus.com/v1.0/token?grant_type=1");
    expect(calls[0]!.headers.access_token).toBeUndefined();
    expect(calls[1]!.headers).toMatchObject({
      client_id: "client123",
      sign_method: "HMAC-SHA256",
      access_token: "access-aaa",
    });
    expect(calls[1]!.headers.t).toMatch(/^\d{13}$/);
    expect(calls[1]!.headers.sign).toMatch(/^[0-9A-F]{64}$/);
    // Never the secret on the wire.
    expect(JSON.stringify(calls)).not.toContain("secret456");
  });

  it("a refused token (1010) is asked again once, then the call retried", async () => {
    answers.push(
      () => ({ json: TOKEN }),
      () => ({ json: { success: false, code: 1010, msg: "token invalid" } }),
      () => ({ json: { ...TOKEN, result: { ...TOKEN.result, access_token: "access-ccc" } } }),
      ok([]),
    );
    await expect(tuyaUserDevices("uid-2")).resolves.toEqual([]);
    expect(calls[3]!.headers.access_token).toBe("access-ccc");
  });

  it("a permission refusal (1106) says what to fix and doesn't pause everything", async () => {
    answers.push(
      () => ({ json: TOKEN }),
      () => ({ json: { success: false, code: 1106, msg: "permission deny" } }),
      ok([]),
    );
    await expect(tuyaUserDevices("uid-3")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      message: expect.stringContaining("isn't authorized"),
    });
    await expect(tuyaUserDevices("uid-4")).resolves.toEqual([]);
  });

  it("a rate limit (429) pauses Tuya instead of hammering it", async () => {
    answers.push(
      () => ({ json: TOKEN }),
      () => ({ status: 429, json: { success: false } }),
    );
    await expect(tuyaUserDevices("uid-5")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(tuyaUserDevices("uid-6")).rejects.toMatchObject({
      message: "Smart Life is paused",
    });
    expect(calls).toHaveLength(2);
  });

  it("a bad signature (1004) pauses the project", async () => {
    answers.push(() => ({ json: { success: false, code: 1004, msg: "sign invalid" } }));
    await expect(tuyaUserDevices("uid-7")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(tuyaUserDevices("uid-8")).rejects.toMatchObject({
      message: "Smart Life is paused",
    });
  });

  it("lists are cached: a second read doesn't ask Tuya", async () => {
    answers.push(() => ({ json: TOKEN }), ok([]));
    await tuyaUserDevices("uid-9");
    await tuyaUserDevices("uid-9");
    expect(calls).toHaveLength(2);
  });
});

describe("commands", () => {
  it("a standard key goes to /command; a learned remote's to /raw/command with its key id", async () => {
    answers.push(() => ({ json: TOKEN }), ok(true), ok(true));
    await tuyaSendKey({
      infraredId: "ir_1",
      remoteId: "rm_1",
      categoryId: 2,
      remoteIndex: 7,
      key: "Mute",
    });
    await tuyaSendKey({
      infraredId: "ir_1",
      remoteId: "rm_2",
      categoryId: 999,
      key: "k",
      keyId: 4,
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "https://openapi.tuyaus.com/v2.0/infrareds/ir_1/remotes/rm_1/command",
    });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ category_id: 2, key: "Mute", remote_index: 7 });
    expect(calls[2]!.url).toMatch(/remotes\/rm_2\/raw\/command$/);
    expect(JSON.parse(calls[2]!.body!)).toEqual({ category_id: 999, key_id: 4, key: "k" });
  });

  it("an air conditioner's state goes as Tuya's numbers (scenes/command)", async () => {
    answers.push(() => ({ json: TOKEN }), ok(true));
    await tuyaSendAc({
      infraredId: "ir_1",
      remoteId: "ac_1",
      categoryId: 5,
      power: true,
      mode: "heat",
      temp: 24,
      fan: "high",
    });
    expect(calls[1]!.url).toMatch(
      /\/v2\.0\/infrareds\/ir_1\/air-conditioners\/ac_1\/scenes\/command$/,
    );
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      power: 1,
      mode: 1,
      temp: 24,
      wind: 3,
      category_id: 5,
    });
  });
});
