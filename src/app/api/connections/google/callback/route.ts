import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { completeGoogleConnection } from "@/application/connections-service";
import { toAppError } from "@/core/errors";
import { trackEvent } from "@/infrastructure/observability/analytics";
import { logger } from "@/infrastructure/observability/logger";

/**
 * Google redirects here after consent. The session must be the one that started the flow;
 * the state is single-use and bound to that user and workspace. Tokens never reach the browser:
 * the user only ever sees a redirect back to Connections.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const back = new URL("/connections", origin);

  const auth = await getAuthContext();
  if (!auth) return NextResponse.redirect(new URL("/login?next=/connections", origin));

  try {
    const result = await completeGoogleConnection(auth, {
      code: searchParams.get("code"),
      state: searchParams.get("state"),
      error: searchParams.get("error"),
      origin,
      onReturnPath: (path) => (back.pathname = path),
    });
    back.searchParams.set("connected", result.connectionId);
    trackEvent(auth, "connection_added", {
      provider: "google",
      capabilities: result.enabled.length,
    });
    if (result.missing.length) back.searchParams.set("missing", result.missing.join(","));
  } catch (error) {
    const e = toAppError(error);
    logger.warn("connection.google_callback_failed", { code: e.code, reference: e.referenceId });
    back.searchParams.set("error", e.code);
  }
  return NextResponse.redirect(back);
}
