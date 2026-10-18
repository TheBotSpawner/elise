import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

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

export const isInternalHref = (href: string) => {
  try {
    return new URL(href, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
};

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(current);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const onPop = () => setLoc(current());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((href: string, opts?: { replace?: boolean }) => {
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin)
      return void window.eliseDesktop?.openExternal(url.href);
    const next = url.pathname + url.search + url.hash;
    if (opts?.replace) window.history.replaceState(null, "", next);
    else window.history.pushState(null, "", next);
    setLoc(current());
    if (!opts?.replace && !url.hash) window.scrollTo(0, 0);
  }, []);

  const value = useMemo<DesktopRouter>(
    () => ({
      ...loc,
      version,
      navigate,
      back: () => window.history.back(),
      refresh: () => setVersion((v) => v + 1),
    }),
    [loc, version, navigate],
  );
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useDesktopRouter(): DesktopRouter {
  const r = useContext(RouterContext);
  if (!r) throw new Error("RouterProvider missing");
  return r;
}
