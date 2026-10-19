import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { cloudAppPath } from "@/core/platform/app-routes";

/**
 * Desktop's local router (ADR-081): history-based, same paths as the web, no server needed to
 * move between screens. refresh() re-reads the current screen's data (what router.refresh()
 * means on the web).
 */
export interface DesktopRouter {
  pathname: string;
  search: string;
  version: number;
  navigate: (href: string, opts?: { replace?: boolean }) => void;
  back: () => void;
  refresh: () => void;
}

const RouterContext = createContext<DesktopRouter | null>(null);

const current = () => ({ pathname: window.location.pathname, search: window.location.search });

/**
 * The in-app path for a link, or null when it leaves ELISE. A link to ELISE Cloud's own address
 * for one of ELISE's screens ("https://…/my-elise/finance") opens here too (ADR-092); anything
 * else is external (the system browser, through the main process's checks).
 */
export function localPath(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin === window.location.origin) return url.pathname + url.search + url.hash;
  return cloudAppPath(url, __ELISE_BUILD__.cloudUrl);
}

export const isInternalHref = (href: string) => localPath(href) !== null;

/** Opens a link in the app, or hands it to the system browser. Also used outside React (RPC). */
export function go(href: string, opts?: { replace?: boolean }) {
  const next = localPath(href);
  if (next === null)
    return void window.eliseDesktop?.openExternal(new URL(href, window.location.href).href);
  if (opts?.replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
  if (!opts?.replace && !next.includes("#")) window.scrollTo(0, 0);
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(current);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onPop = () => setLoc(current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Back from the system browser (an OAuth consent, a page opened outside): the screen reads its
  // data again, so what happened there shows here without a manual reload.
  useEffect(() => {
    let blurredAt = 0;
    const onBlur = () => (blurredAt = Date.now());
    const onFocus = () => {
      if (blurredAt && Date.now() - blurredAt > 5000) setVersion((v) => v + 1);
      blurredAt = 0;
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const value = useMemo<DesktopRouter>(
    () => ({
      ...loc,
      version,
      navigate: go,
      back: () => window.history.back(),
      refresh: () => setVersion((v) => v + 1),
    }),
    [loc, version],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useDesktopRouter(): DesktopRouter {
  const r = useContext(RouterContext);
  if (!r) throw new Error("RouterProvider missing");
  return r;
}
