import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";

import { FakeSupabase } from "../../fixtures/fake-supabase";

/**
 * ELISE Desktop sign-in (ADR-081): the person approves in their own browser; only the app that
 * holds the PKCE verifier, for the same installation, redeems the code — once, before it expires.
 */
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ db: null as unknown, minted: [] as string[] }));
vi.mock("@/infrastructure/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/infrastructure/supabase/desktop-session", () => ({
  mintSessionForUser: async (userId: string) => {
    state.minted.push(userId);
    return { accessToken: "at", refreshToken: "rt", expiresAt: null };
  },
}));

const { createDesktopAuthCode, exchangeDesktopCode, desktopHeartbeat, listDesktops } =
  await import("@/application/desktop-service");

const verifier = "v".repeat(20) + "erifier-for-pkce-tests-0123456789abcdef";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const installation = "33333333-3333-4333-8333-333333333333";
let db: FakeSupabase;
let auth: AuthContext;

beforeEach(() => {
  db = new FakeSupabase();
  state.db = db;
  state.minted = [];
  db.defaults.desktop_auth_codes = { used_at: null };
  auth = { db, userId: "user-1", workspaceId: "ws-1" } as unknown as AuthContext;
});

async function approve() {
  const { redirect } = await createDesktopAuthCode(auth, {
    challenge,
    state: "s".repeat(24),
    installation,
  });
  const url = new URL(redirect);
  expect(url.protocol).toBe("elise:");
  expect(url.searchParams.get("state")).toBe("s".repeat(24));
  return url.searchParams.get("code")!;
}

describe("Desktop sign-in", () => {
  it("only the code's hash is stored; the right verifier gets a session, once", async () => {
    const code = await approve();
    expect(JSON.stringify(db.rows("desktop_auth_codes"))).not.toContain(code);
    const s = await exchangeDesktopCode({ code, verifier, installationId: installation });
    expect(s).toMatchObject({ userId: "user-1", workspaceId: "ws-1", refreshToken: "rt" });
    await expect(
      exchangeDesktopCode({ code, verifier, installationId: installation }),
    ).rejects.toThrow();
    expect(state.minted).toEqual(["user-1"]);
  });

  it("a wrong verifier, another installation or an expired code gets nothing", async () => {
    const code = await approve();
    await expect(
      exchangeDesktopCode({
        code,
        verifier: verifier.replace("v", "w"),
        installationId: installation,
      }),
    ).rejects.toThrow();
    const code2 = await approve();
    await expect(
      exchangeDesktopCode({
        code: code2,
        verifier,
        installationId: "44444444-4444-4444-8444-444444444444",
      }),
    ).rejects.toThrow();
    const code3 = await approve();
    for (const r of db.rows("desktop_auth_codes"))
      r.expires_at = new Date(Date.now() - 1000).toISOString();
    await expect(
      exchangeDesktopCode({ code: code3, verifier, installationId: installation }),
    ).rejects.toThrow();
    expect(state.minted).toEqual([]);
  });

  it("refuses malformed approval requests", async () => {
    await expect(
      createDesktopAuthCode(auth, { challenge: "short", state: "s".repeat(24), installation }),
    ).rejects.toThrow();
  });
});

describe("Desktop presence", () => {
  it("records version, protocol and capabilities as the person; says if an update is required", async () => {
    const r = await desktopHeartbeat(auth, {
      installationId: installation,
      platform: "windows",
      desktopVersion: "1.0.0",
      bridgeProtocolVersion: 1,
      capabilities: ["home_hub"],
    });
    expect(r).toEqual({ minBridgeProtocolVersion: 1, updateRequired: false });
    expect(db.rows("desktop_installations")[0]).toMatchObject({
      user_id: "user-1",
      installation_id: installation,
      capabilities: ["home_hub"],
    });
    await expect(
      desktopHeartbeat(auth, {
        installationId: installation,
        platform: "windows",
        desktopVersion: "1.0.0",
        bridgeProtocolVersion: 1,
        capabilities: ["computer_control"],
      }),
    ).rejects.toThrow();
  });
});

describe("Desktop presence for Hogar", () => {
  it("only this person's computers in this workspace count; Home progress travels with them", async () => {
    await desktopHeartbeat(auth, {
      installationId: installation,
      platform: "windows",
      desktopVersion: "1.0.0",
      bridgeProtocolVersion: 1,
      capabilities: ["home_hub"],
      homeRuntime: { phase: "downloading", enabled: true, progress: 42 },
    });
    // Someone else's computer, and this person's computer in another workspace.
    db.rows("desktop_installations").push(
      {
        user_id: "user-2",
        workspace_id: "ws-1",
        installation_id: "x",
        name: "Ajena",
        platform: "windows",
        revoked_at: null,
      },
      {
        user_id: "user-1",
        workspace_id: "ws-2",
        installation_id: "y",
        name: "Oficina",
        platform: "windows",
        revoked_at: null,
      },
    );
    const mine = await listDesktops(auth);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      homeEnabled: true,
      homeRuntimePhase: "downloading",
      homeRuntimeProgress: 42,
    });
  });
});
