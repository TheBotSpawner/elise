import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { completeTuyaConnection, TUYA_FLOW_COOKIE } from "@/application/tuya-connection-service";
import { toAppError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";

/**
 * ADR-119: Tuya sends the person back here after they authorize on its official page — one
 * callback per data center (the code only works in the person's own). The flow is consumed once;
 * the token never leaves the server. Lands on Hogar with the outcome.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ region: string }> }) {
  const { region } = await ctx.params;
  const { searchParams, origin } = request.nextUrl;
  const back = new URL("/my-elise/home", origin);
  const auth = await getAuthContext().catch(() => null);
  try {
    await completeTuyaConnection({
      pathRegion: region,
      code: searchParams.get("code"),
      state: searchParams.get("state"),
      cookieState: request.cookies.get(TUYA_FLOW_COOKIE)?.value ?? null,
      sessionUserId: auth?.userId ?? null,
    });
    back.searchParams.set("tuya", "connected");
  } catch (error) {
    const e = toAppError(error);
    const problem = (e.details as { tuyaProblem?: string } | undefined)?.tuyaProblem;
    logger.warn("tuya_oauth_callback_failed", { code: e.code, problem, reference: e.referenceId });
    back.searchParams.set("tuya_error", problem ?? e.code);
  }
  const res = NextResponse.redirect(back);
  res.cookies.delete({ name: TUYA_FLOW_COOKIE, path: "/api/connections/tuya" });
  return res;
}
