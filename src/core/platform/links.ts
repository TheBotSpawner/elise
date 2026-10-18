/**
 * Links that cross the Desktop boundary (ADR-081). Deep links only ever navigate or complete
 * sign-in — never run a native action. External links open in the system browser only when
 * they're plain http(s).
 */
export type DeepLink =
  { kind: "navigate"; path: string } | { kind: "auth_callback"; code: string; state: string };

/** The in-app routes a deep link may open. */
const ROUTES: readonly RegExp[] = [
  /^\/$/,
  /^\/home$/,
  /^\/home\/(setup|diagnostics)$/,
  /^\/conversation\/[0-9a-f-]{36}$/i,
];

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export function parseDeepLink(raw: string): DeepLink | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "elise:" || raw.length > 2048) return null;
  // elise://home/setup → host "home", pathname "/setup".
  const path = `/${u.host}${u.pathname === "/" ? "" : u.pathname}`.replace(/\/+$/, "") || "/";
  if (path === "/auth/callback") {
    const code = u.searchParams.get("code") ?? "";
    const state = u.searchParams.get("state") ?? "";
    return TOKEN.test(code) && TOKEN.test(state) ? { kind: "auth_callback", code, state } : null;
  }
  if (!ROUTES.some((r) => r.test(path))) return null;
  // Deep-link routes → app routes.
  if (path === "/home") return { kind: "navigate", path: "/my-elise/home" };
  if (path.startsWith("/home/")) return { kind: "navigate", path: "/my-elise/home" };
  if (path.startsWith("/conversation/"))
    return { kind: "navigate", path: `/history/${path.split("/")[2]}` };
  return { kind: "navigate", path };
}

/** Only plain web links leave the app, and only to the system browser. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Last-known data Desktop may keep (ADR-081): an allowlist, never a mirror of the database. */
export const CACHEABLE_SNAPSHOTS = ["bootstrap", "page:/", "page:/my-elise/home"] as const;
export const SNAPSHOT_SCHEMA_VERSION = 1;

export const isCacheableSnapshot = (key: string): boolean =>
  (CACHEABLE_SNAPSHOTS as readonly string[]).includes(key);
