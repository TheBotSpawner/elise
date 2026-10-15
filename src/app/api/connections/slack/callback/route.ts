import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { completeSlackConnection } from "@/application/connections-service";
import { toAppError } from "@/core/errors";
import { trackEvent } from "@/infrastructure/observability/analytics";
import { logger } from "@/infrastructure/observability/logger";

/**
 * Slack redirects here after consent (ADR-062). The state is single-use and bound to this user
 * and workspace; tokens go straight to the encrypted vault and never reach the browser.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const back = new URL("/connections", origin);
  back.searchParams.set("provider", "slack");

  const auth = await getAuthContext();
  if (!auth) return NextResponse.redirect(new URL("/login?next=/connections", origin));

  try {
    const result = await completeSlackConnection(auth, {
      code: searchParams.get("code"),
      state: searchParams.get("state"),
      error: searchParams.get("error"),
      origin,
      onReturnPath: (path) => (back.pathname = path),
    });
    back.searchParams.set("connected", result.connectionId);
    trackEvent(auth, "connection_added", {
      provider: "slack",
      capabilities: result.enabled.length,
    });
  } catch (error) {
    const e = toAppError(error);
    const reason =
      typeof e.details?.reason === "string"
        ? e.details.reason
        : typeof e.details?.setup === "string"
          ? e.details.setup
          : null;
    logger.warn("connection.slack_callback_failed", {
      code: e.code,
      reason,
      providerError: searchParams.get("error")?.slice(0, 64) ?? null,
      missing: e.details?.missing,
      reference: e.referenceId,
    });
    back.searchParams.set("error", e.code);
    back.searchParams.set("ref", e.referenceId);
    if (reason) back.searchParams.set("reason", reason);
  }
  return NextResponse.redirect(back);
}
