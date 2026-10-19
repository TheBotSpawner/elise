/**
 * ELISE's internal screens, by path (ADR-092). One list for the web and ELISE Desktop: the web
 * renders each with its page; Desktop's local renderer resolves the same path to the same view,
 * with the same loader run by ELISE Cloud. A path that matches none is "not found" in the app —
 * never a silent hand-off to the browser.
 *
 * Patterns use the App Router's own segment syntax: "/my-elise/lists/[id]".
 */
export const APP_ROUTES = [
  "/",
  "/approvals",
  "/chat",
  "/chat/[id]",
  "/connections",
  "/connections/[provider]",
  "/connections/sources/new",
  "/connections/sources/[id]",
  "/download/desktop",
  "/knowledge",
  "/knowledge/items/[id]",
  "/knowledge/spaces/[id]",
  "/my-elise",
  "/my-elise/contexts",
  "/my-elise/contexts/[id]",
  "/my-elise/finance",
  "/my-elise/finance/connect",
  "/my-elise/finance/import/[id]",
  "/my-elise/finance/reports",
  "/my-elise/finance/sources",
  "/my-elise/goals",
  "/my-elise/habits",
  "/my-elise/home",
  "/my-elise/lists",
  "/my-elise/lists/[id]",
  "/my-elise/methods",
  "/my-elise/notes",
  "/my-elise/shortcuts",
  "/my-elise/tasks",
  "/my-elise/time",
  "/schedules",
  "/schedules/results/[id]",
  "/settings",
  "/settings/account",
  "/settings/appearance",
  "/settings/billing",
  "/settings/desktop",
  "/settings/general",
  "/settings/memory",
  "/settings/personality",
  "/settings/shortcuts",
  "/settings/storage",
  "/settings/storage/[category]",
  "/settings/usage",
  "/settings/voice",
  "/admin/perf",
  "/admin/usage",
  // First run: full screen, outside the app's shell.
  "/onboarding",
] as const;

export type AppRoute = (typeof APP_ROUTES)[number];

export interface RouteMatch {
  route: AppRoute;
  /** Dynamic segments, decoded ("[id]" → { id }). */
  params: Record<string, string>;
}

const SEGMENT = /^\[([a-z]+)\]$/i;

/** A static segment beats a dynamic one ("/sources/new" before "/sources/[id]"). */
export function matchAppRoute(pathname: string): RouteMatch | null {
  const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  let best: { match: RouteMatch; dynamic: number } | null = null;
  for (const route of APP_ROUTES) {
    const pattern = route.split("/").filter(Boolean);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let dynamic = 0;
    const ok = pattern.every((seg, i) => {
      const name = SEGMENT.exec(seg)?.[1];
      if (!name) return seg === parts[i];
      let value: string;
      try {
        value = decodeURIComponent(parts[i]!);
      } catch {
        return false;
      }
      if (!value || value.length > 200 || /[/\\]/.test(value)) return false;
      params[name] = value;
      dynamic++;
      return true;
    });
    if (ok && (!best || dynamic < best.dynamic)) best = { match: { route, params }, dynamic };
  }
  return best?.match ?? null;
}

/**
 * Screens with no data from ELISE Cloud (no load.ts): Desktop renders them at once, even
 * offline. "/settings/desktop" is Desktop's own section (it has no web page).
 */
export const VIEW_ONLY_ROUTES: ReadonlySet<AppRoute> = new Set<AppRoute>([
  "/my-elise/time",
  "/settings/billing",
  "/settings/desktop",
]);

/** "/settings/storage/[category]" belongs to the Settings shell. */
export const isSettingsRoute = (route: AppRoute) =>
  route === "/settings" || route.startsWith("/settings/");

/**
 * A link to ELISE Cloud's own address for one of ELISE's screens ("https://…/my-elise/tasks")
 * stays in Desktop's window (ADR-092): its in-app path, or null for anything else. The one rule
 * both the renderer and the main process apply.
 */
export function cloudAppPath(url: URL, cloudUrl: string): string | null {
  let cloud: string;
  try {
    cloud = new URL(cloudUrl).origin;
  } catch {
    return null; // no cloud configured (development): nothing else is in-app
  }
  return url.origin === cloud && matchAppRoute(url.pathname)
    ? url.pathname + url.search + url.hash
    : null;
}
