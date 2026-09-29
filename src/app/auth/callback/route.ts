import { NextResponse, type NextRequest } from "next/server";

import { completeAuthRedirect } from "@/infrastructure/auth/callback";
import { logger } from "@/infrastructure/observability/logger";
import { safeNextPath } from "@/lib/safe-redirect";

/** Completes OAuth and email sign-in links, then goes to an allowlisted in-app path. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const result = await completeAuthRedirect(searchParams);
  if (!result.ok) {
    logger.info("auth.callback_failed", { code: result.code });
    return NextResponse.redirect(new URL("/login?error=link", origin));
  }
  return NextResponse.redirect(new URL(safeNextPath(searchParams.get("next")), origin));
}
