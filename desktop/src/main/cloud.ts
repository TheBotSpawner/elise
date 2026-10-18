import { app, net, shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

import { createServerClient } from "@supabase/ssr";

import type { DesktopSession, EliseConnectivity } from "@/core/platform/platform";

import { log } from "./log";
import { loadState, readSecrets, writeSecrets, type DesktopSecrets } from "./store";

/**
 * ELISE Cloud from Desktop (ADR-081). The main process holds the person's session — the same
 * Supabase session cookies a browser keeps, encrypted by the OS — and attaches them to the
 * renderer's /api requests. The renderer never sees the refresh token, only a short-lived
 * access token when it needs one (Realtime, uploads).
 */
const BUILD = __ELISE_BUILD__;
const b64url = (b: Buffer) => b.toString("base64url");

export const events = new EventEmitter();

let secrets: DesktopSecrets = {};
let cloud: EliseConnectivity["cloud"] = "offline";
let internet: EliseConnectivity["internet"] = "unknown";

export function initCloud() {
  secrets = readSecrets();
}

const persist = () => writeSecrets(secrets);

// ---- Session cookies (the browser's jar, in memory + OS-encrypted on disk) ----

function supabase() {
  return createServerClient(BUILD.supabaseUrl, BUILD.supabasePublishableKey, {
    cookies: {
      getAll: () => Object.entries(secrets.cookies ?? {}).map(([name, value]) => ({ name, value })),
      setAll: (list) => {
        const jar = { ...(secrets.cookies ?? {}) };
        for (const { name, value, options } of list) {
          if (!value || options?.maxAge === 0) delete jar[name];
          else jar[name] = value;
        }
        secrets = { ...secrets, cookies: jar };
        persist();
      },
    },
  });
}

/** Set-Cookie from ELISE Cloud (its proxy refreshes the session): keep only auth cookies. */
export function absorbSetCookies(headers: Headers) {
  const list = headers.getSetCookie?.() ?? [];
  if (!list.length) return;
  const jar = { ...(secrets.cookies ?? {}) };
  let changed = false;
  for (const raw of list) {
    const [pair, ...attrs] = raw.split(";");
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq).trim();
    if (!name.startsWith("sb-")) continue;
    const value = decodeURIComponent(pair!.slice(eq + 1).trim());
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || !value;
    if (expired) delete jar[name];
    else jar[name] = value;
    changed = true;
  }
  if (changed) {
    secrets = { ...secrets, cookies: jar };
    persist();
  }
}

export const cookieHeader = () =>
  Object.entries(secrets.cookies ?? {})
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("; ");

export function session(): DesktopSession {
  const signedIn = Boolean(secrets.userId && Object.keys(secrets.cookies ?? {}).length);
  return {
    signedIn,
    userId: signedIn ? secrets.userId! : null,
    workspaceId: signedIn ? secrets.workspaceId! : null,
  };
}

/** Cache and local data are scoped per account and workspace. */
export const sessionScope = () => {
  const s = session();
  return s.signedIn ? `${s.userId}.${s.workspaceId}` : null;
};

export async function accessToken(): Promise<string | null> {
  if (!session().signedIn) return null;
  try {
    const { data } = await supabase().auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export const hubToken = () => secrets.hubToken ?? null;
export function setHubToken(token: string | null, workspaceId: string | null) {
  secrets = { ...secrets, hubToken: token ?? undefined, hubWorkspaceId: workspaceId ?? undefined };
  persist();
}

/** Local Home control needs someone signed in to the workspace that home belongs to. */
export const mayControlLocalHome = () =>
  session().signedIn &&
  Boolean(secrets.hubWorkspaceId) &&
  secrets.workspaceId === secrets.hubWorkspaceId;

// ---- Requests to ELISE Cloud ----

export async function cloudFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-elise-client", "desktop");
  const cookies = cookieHeader();
  if (cookies) headers.set("cookie", cookies);
  try {
    const res = await fetch(`${BUILD.cloudUrl}${path}`, {
      ...init,
      headers,
      redirect: "manual",
      ...(init.body ? { duplex: "half" } : {}),
    } as RequestInit);
    absorbSetCookies(res.headers);
    setCloud(res.status >= 500 && res.status !== 503 ? "degraded" : "online");
    if (res.status === 401 && session().signedIn && path.startsWith("/api/desktop/page")) {
      // The session was revoked elsewhere: sign out here too.
      await signOutLocal("revoked");
    }
    return res;
  } catch (error) {
    setCloud("offline");
    throw error;
  }
}

function setCloud(next: EliseConnectivity["cloud"]) {
  const nextInternet = net.isOnline() ? "online" : "offline";
  if (next === cloud && nextInternet === internet) return;
  cloud = next;
  internet = nextInternet;
  log("desktop_cloud", { cloud, internet });
  events.emit("connectivity");
}

export const cloudState = () => ({ cloud, internet });

/** Reconnect in the background: quick while offline, rare while fine. */
export function watchCloud() {
  const probe = async () => {
    try {
      const r = await fetch(`${BUILD.cloudUrl}/api/health`, { signal: AbortSignal.timeout(8000) });
      setCloud(r.ok ? "online" : "degraded");
    } catch {
      setCloud("offline");
    }
    setTimeout(probe, cloud === "online" ? 120_000 : 15_000);
  };
  void probe();
}
export async function probeNow() {
  try {
    const r = await fetch(`${BUILD.cloudUrl}/api/health`, { signal: AbortSignal.timeout(8000) });
    setCloud(r.ok ? "online" : "degraded");
  } catch {
    setCloud("offline");
  }
}

// ---- Sign-in through the system browser (PKCE + elise://auth/callback) ----

let pending: { state: string; verifier: string; resolve: (ok: boolean) => void } | null = null;

export async function signIn(): Promise<void> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const url = new URL("/desktop/connect", BUILD.cloudUrl);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("state", state);
  url.searchParams.set("installation", loadState().installationId);
  pending?.resolve(false);
  const done = new Promise<boolean>((resolve) => (pending = { state, verifier, resolve }));
  await shell.openExternal(url.toString());
  log("desktop_sign_in_started");
  const timer = setTimeout(() => pending?.resolve(false), 10 * 60_000);
  void done.finally(() => clearTimeout(timer));
}

/** From the deep link. Only the request this app started (same state) is accepted. */
export async function completeSignIn(code: string, state: string): Promise<boolean> {
  if (!pending || pending.state !== state) {
    log("desktop_sign_in_unexpected_callback");
    return false;
  }
  const { verifier, resolve } = pending;
  pending = null;
  try {
    const res = await cloudFetch("/api/desktop/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier, installationId: loadState().installationId }),
    });
    if (!res.ok) throw new Error(`session ${res.status}`);
    await adoptSession((await res.json()) as MintedSession);
    resolve(true);
    return true;
  } catch (error) {
    log("desktop_sign_in_failed", { message: (error as Error).message });
    resolve(false);
    return false;
  }
}

interface MintedSession {
  accessToken: string;
  refreshToken: string;
  userId: string;
  workspaceId: string;
}

async function adoptSession(s: MintedSession) {
  secrets = { ...secrets, cookies: {}, userId: s.userId, workspaceId: s.workspaceId };
  await supabase().auth.setSession({ access_token: s.accessToken, refresh_token: s.refreshToken });
  persist();
  log("desktop_signed_in");
  events.emit("session");
}

/**
 * Automated validation only: an unpackaged build may start with a session from the
 * environment (a throwaway test account). A packaged app never reads this.
 */
export async function adoptTestSession() {
  const raw = process.env.ELISE_DESKTOP_TEST_SESSION;
  if (app.isPackaged || !raw) return;
  await adoptSession(JSON.parse(raw) as MintedSession);
}

/** Sign out here: revoke this session, forget it and this account's local data. */
export async function signOutLocal(reason: "user" | "revoked") {
  try {
    if (reason === "user") await supabase().auth.signOut({ scope: "local" });
  } catch {
    // offline: the local copy is still removed
  }
  // The hub credential is the home's, not the person's: kept until Hogar unlinks it (ADR-081).
  secrets = { hubToken: secrets.hubToken, hubWorkspaceId: secrets.hubWorkspaceId };
  persist();
  log("desktop_signed_out", { reason });
  events.emit("session");
}
