import { useMemo } from "react";

import { useDesktopRouter } from "../router";

/** next/navigation for Desktop's local router (ADR-081): only what ELISE's client code uses. */
export function useRouter() {
  const r = useDesktopRouter();
  return useMemo(
    () => ({
      push: (href: string) => r.navigate(href),
      replace: (href: string) => r.navigate(href, { replace: true }),
      refresh: () => r.refresh(),
      back: () => r.back(),
      forward: () => window.history.forward(),
      prefetch: () => undefined,
    }),
    [r],
  );
}

export const usePathname = () => useDesktopRouter().pathname;

export function useSearchParams() {
  const { search } = useDesktopRouter();
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function redirect(href: string): never {
  window.history.replaceState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
  throw new Error("NEXT_REDIRECT");
}

export function notFound(): never {
  throw new Error("NEXT_NOT_FOUND");
}
