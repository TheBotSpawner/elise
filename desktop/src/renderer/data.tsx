import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { isCacheableSnapshot } from "@/core/platform/links";
import type { DesktopSession, EliseConnectivity } from "@/core/platform/platform";

import { useDesktopRouter } from "./router";

const bridge = () => window.eliseDesktop!;

const INITIAL: EliseConnectivity = {
  internet: "unknown",
  cloud: "online",
  localRuntime: "offline",
  home: "not_configured",
};

const ConnectivityContext = createContext<EliseConnectivity>(INITIAL);
const SessionContext = createContext<DesktopSession | null>(null);

export function DesktopStateProvider({ children }: { children: ReactNode }) {
  const [connectivity, setConnectivity] = useState(INITIAL);
  const [session, setSession] = useState<DesktopSession | null>(null);
  useEffect(() => {
    void bridge().getConnectivity().then(setConnectivity);
    void bridge().getSession().then(setSession);
    const offC = bridge().onConnectivity(setConnectivity);
    const offS = bridge().onSession(setSession);
    return () => {
      offC();
      offS();
    };
  }, []);
  return (
    <SessionContext.Provider value={session}>
      <ConnectivityContext.Provider value={connectivity}>{children}</ConnectivityContext.Provider>
    </SessionContext.Provider>
  );
}

export const useConnectivity = () => useContext(ConnectivityContext);
export const useSession = () => useContext(SessionContext);

export type PageData<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; cachedAt: string | null }
  | { status: "offline" }
  | { status: "not_available" }
  | { status: "error"; message: string };

/**
 * A screen's data from ELISE Cloud (the web's own loaders), falling back to the last-known copy
 * when the cloud is unreachable — always labelled with its age, never shown as current. Keeps
 * what's on screen while refreshing, so router.refresh() doesn't flash.
 */
export function usePageData<T>(path: string): PageData<T> & { reload: () => void } {
  const { version } = useDesktopRouter();
  const { cloud } = useConnectivity();
  const [state, setState] = useState<PageData<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const base = path.split("?")[0];
  // Only the plain screen is kept (not ?session=… variants).
  const cacheKey = path.includes("?") ? "" : base === "/__bootstrap" ? "bootstrap" : `page:${base}`;

  useEffect(() => {
    const mine = ++seq.current;
    const apply = (s: PageData<T>) => mine === seq.current && setState(s);
    void (async () => {
      try {
        const res = await fetch(`/api/desktop/page?path=${encodeURIComponent(path)}`);
        if (res.ok) {
          const data = (await res.json()) as T;
          apply({ status: "ready", data, cachedAt: null });
          if (isCacheableSnapshot(cacheKey)) void bridge().cacheSet(cacheKey, data);
          return;
        }
        if (res.status === 404) return apply({ status: "not_available" });
        if (res.status !== 503) {
          const body = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          return apply({ status: "error", message: body?.error?.message ?? `HTTP ${res.status}` });
        }
      } catch {
        // unreachable: last-known below
      }
      const cached = isCacheableSnapshot(cacheKey) ? await bridge().cacheGet(cacheKey) : null;
      apply(
        cached
          ? { status: "ready", data: cached.value as T, cachedAt: cached.cachedAt }
          : { status: "offline" },
      );
    })();
    // Back online → fresh data.
  }, [path, cacheKey, version, nonce, cloud === "online"]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, reload: () => setNonce((n) => n + 1) };
}
