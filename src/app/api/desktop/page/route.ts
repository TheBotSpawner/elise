import { isHTTPAccessFallbackError } from "next/dist/client/components/http-access-fallback/http-access-fallback";
import { NextResponse, type NextRequest } from "next/server";

import { listPendingApprovals } from "@/application/approvals-service";
import { getAuthContext } from "@/application/auth-context";
import { visibleModules } from "@/application/modules-service";
import { AppError } from "@/core/errors";
import { matchAppRoute } from "@/core/platform/app-routes";

import { homePageProps } from "../../../(app)/home-props";
import { homeHubPageProps, homeProviderKeys } from "../../../(app)/my-elise/home/props";
import type { RouteSearch } from "../../../(app)/route-contract";
import { ROUTE_LOADERS } from "../../../(app)/route-loaders";
import { desktopError, redirectTarget, requireDesktopClient } from "../respond";

export const dynamic = "force-dynamic";

/**
 * Page data for ELISE Desktop's local renderer (ADR-081/092): the same loaders the web pages
 * use, as JSON — `{ props }`, or `{ redirect }` when the loader redirects. "bootstrap" is the
 * authenticated frame (what the (app) layout reads). Any other path resolves through the shared
 * route list; what it doesn't know is "not found", never a hand-off to the browser.
 */
export async function GET(request: NextRequest) {
  try {
    requireDesktopClient(request);
    const auth = await getAuthContext();
    if (!auth) throw new AppError("AUTH_ERROR", "Please sign in", { recovery: "sign_in" });
    const url = new URL(request.nextUrl.searchParams.get("path") ?? "/", "http://desktop");
    // Repeated keys stay lists, as Next gives them to a page.
    const search: RouteSearch = {};
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      search[key] = all.length > 1 ? all : all[0];
    }
    switch (url.pathname) {
      case "/__bootstrap": {
        const [pending, modules] = await Promise.all([
          listPendingApprovals(auth).catch(() => []),
          visibleModules(auth),
        ]);
        const name = auth.profile.displayName || auth.email?.split("@")[0] || "ELISE";
        return NextResponse.json({
          userId: auth.userId,
          workspaceId: auth.workspaceId,
          onboardingStatus: auth.profile.onboardingStatus,
          pendingApprovals: pending.length,
          modules,
          user: { name, initial: name.charAt(0).toUpperCase(), email: auth.email },
          profile: {
            locale: auth.profile.locale,
            theme: auth.profile.theme,
            accent: auth.profile.accent,
            dateOrder: auth.profile.dateOrder,
            voice: auth.profile.voice,
          },
        });
      }
      case "/":
        return NextResponse.json(await homePageProps(auth, search));
      case "/my-elise/home": {
        const [props, providerKeys] = await Promise.all([
          homeHubPageProps(auth),
          homeProviderKeys(auth).catch(() => ({})),
        ]);
        return NextResponse.json({ props, providerKeys });
      }
      default: {
        const match = matchAppRoute(url.pathname);
        const loader = match && ROUTE_LOADERS[match.route];
        if (!match || !loader) throw new AppError("NOT_FOUND", "Page not found");
        try {
          return NextResponse.json({
            props: await loader(auth, { params: match.params, search }),
          });
        } catch (error) {
          const redirect = redirectTarget(error);
          if (redirect) return NextResponse.json({ redirect });
          if (isHTTPAccessFallbackError(error)) throw new AppError("NOT_FOUND", "Page not found");
          throw error;
        }
      }
    }
  } catch (error) {
    return desktopError(error, "desktop_page_failed");
  }
}
