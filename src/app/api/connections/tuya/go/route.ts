import { NextResponse, type NextRequest } from "next/server";

import { TUYA_FLOW_COOKIE, tuyaAuthorizationUrl } from "@/application/tuya-connection-service";
import { toAppError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";

/**
 * ADR-119: ELISE's own hop before Tuya's official authorization page. It runs in the browser
 * that will see Tuya's page (the system browser when the flow starts in ELISE Desktop) and binds
 * the flow to it with an HttpOnly cookie: the callback only completes in that browser.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const state = searchParams.get("s") ?? "";
  try {
    const to = await tuyaAuthorizationUrl(state);
    const res = NextResponse.redirect(to);
    res.cookies.set(TUYA_FLOW_COOKIE, state, {
      httpOnly: true,
      secure: origin.startsWith("https://"),
      sameSite: "lax",
      path: "/api/connections/tuya",
      maxAge: 600,
    });
    return res;
  } catch (error) {
    const e = toAppError(error);
    logger.warn("tuya_oauth_go_failed", { code: e.code });
    const back = new URL("/my-elise/home", origin);
    back.searchParams.set("tuya_error", e.code);
    return NextResponse.redirect(back);
  }
}
