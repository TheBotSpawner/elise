import { NextResponse, type NextRequest } from "next/server";

import { listPendingApprovals } from "@/application/approvals-service";
import { getAuthContext } from "@/application/auth-context";
import { visibleModules } from "@/application/modules-service";
import { AppError } from "@/core/errors";

import { homePageProps } from "../../../(app)/home-props";
import { homeHubPageProps, homeProviderKeys } from "../../../(app)/my-elise/home/props";
import { desktopError, requireDesktopClient } from "../respond";

export const dynamic = "force-dynamic";

/**
 * Page data for ELISE Desktop's local renderer (ADR-081): the same loaders the web pages use,
 * as JSON. "bootstrap" is the authenticated frame (what the (app) layout reads).
 */
export async function GET(request: NextRequest) {
  try {
    requireDesktopClient(request);
    const auth = await getAuthContext();
    if (!auth) throw new AppError("AUTH_ERROR", "Please sign in", { recovery: "sign_in" });
    const url = new URL(request.nextUrl.searchParams.get("path") ?? "/", "http://desktop");
    const params = Object.fromEntries(url.searchParams);
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
          },
        });
      }
      case "/":
        return NextResponse.json(await homePageProps(auth, params));
      case "/my-elise/home": {
        const [props, providerKeys] = await Promise.all([
          homeHubPageProps(auth),
          homeProviderKeys(auth).catch(() => ({})),
        ]);
        return NextResponse.json({ props, providerKeys });
      }
      default:
        throw new AppError("NOT_FOUND", "This section isn't in ELISE Desktop yet");
    }
  } catch (error) {
    return desktopError(error, "desktop_page_failed");
  }
}
