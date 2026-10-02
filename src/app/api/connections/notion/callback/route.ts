import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { completeNotionConnection } from "@/application/connections-service";
import { toAppError } from "@/core/errors";
import { trackEvent } from "@/infrastructure/observability/analytics";
import { logger } from "@/infrastructure/observability/logger";

/** Notion redirects here after consent. Same guarantees as the Google callback. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const back = new URL("/connections", origin);
  const auth = await getAuthContext();
  if (!auth) return NextResponse.redirect(new URL("/login?next=/connections", origin));
  try {
    const connectionId = await completeNotionConnection(auth, {
      code: searchParams.get("code"),
      state: searchParams.get("state"),
      error: searchParams.get("error"),
      origin,
      onReturnPath: (path) => (back.pathname = path),
    });
    back.searchParams.set("connected", connectionId);
    trackEvent(auth, "connection_added", { provider: "notion" });
    back.searchParams.set("provider", "notion");
  } catch (error) {
    const e = toAppError(error);
    logger.warn("connection.notion_callback_failed", { code: e.code, reference: e.referenceId });
    back.searchParams.set("error", e.code);
  }
  return NextResponse.redirect(back);
}
