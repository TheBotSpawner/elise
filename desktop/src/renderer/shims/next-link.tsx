import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from "react";

import { isInternalHref, useDesktopRouter } from "../router";

type Href = string | { pathname?: string; query?: Record<string, string | number | undefined> };

/** next/link for Desktop: same markup, local navigation for in-app links. */
const Link = forwardRef<
  HTMLAnchorElement,
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: Href;
    replace?: boolean;
    scroll?: boolean;
    prefetch?: boolean | null;
  }
>(function Link({ href, replace, scroll, prefetch, onClick, ...rest }, ref) {
  void scroll; // Desktop always restores scroll itself; nothing to prefetch locally
  void prefetch;
  const router = useDesktopRouter();
  const url =
    typeof href === "string"
      ? href
      : `${href.pathname ?? ""}${
          href.query
            ? `?${new URLSearchParams(
                Object.entries(href.query).flatMap(([k, v]) =>
                  v === undefined ? [] : [[k, String(v)]],
                ),
              )}`
            : ""
        }`;
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    if (rest.target && rest.target !== "_self") return;
    if (!isInternalHref(url)) return;
    e.preventDefault();
    router.navigate(url, { replace });
  };
  return <a ref={ref} href={url} onClick={click} {...rest} />;
});

export default Link;
