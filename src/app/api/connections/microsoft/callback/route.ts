import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { completeMicrosoftConnection } from "@/application/connections-service";
import { toAppError } from "@/core/errors";
import { trackEvent } from "@/infrastructure/observability/analytics";
import { logger } from "@/infrastructure/observability/logger";

/**
 * Microsoft redirects here after consent (ADR-058). Same guarantees as Google's callback: the
 * state is single-use and bound to this user and workspace, and tokens never reach the browser.
 * Failures carry an error code plus, when known, a precise reason (cancelled, admin approval…).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const back = new URL("/connections", origin);
  back.searchParams.set("provider", "microsoft");

  const auth = await getAuthContext();
  if (!auth) return NextResponse.redirect(new URL("/login?next=/connections", origin));

  try {
    const result = await completeMicrosoftConnection(auth, {
      code: searchParams.get("code"),
      state: searchParams.get("state"),
      error: searchParams.get("error"),
      errorDescription: searchParams.get("error_description"),
      origin,
      onReturnPath: (path) => (back.pathname = path),
    });
    back.searchParams.set("connected", result.connectionId);
    trackEvent(auth, "connection_added", {
      provider: "microsoft",
      capabilities: result.enabled.length,
    });
    if (result.missing.length) back.searchParams.set("missing", result.missing.join(","));
  } catch (error) {
    const e = toAppError(error);
    const reason =
      typeof e.details?.reason === "string"
        ? e.details.reason
        : typeof e.details?.setup === "string"
          ? e.details.setup
          : null;
    // Microsoft's own error code and AADSTS numbers are safe to log; its free-text description
    // (which can echo identifiers) is not.
    const aadsts = [...(searchParams.get("error_description") ?? "").matchAll(/AADSTS(\d+)/g)].map(
      (m) => Number(m[1]),
    );
    logger.warn("connection.microsoft_callback_failed", {
      code: e.code,
      reason,
      providerError: searchParams.get("error")?.slice(0, 64) ?? null,
      aadsts,
      missing: e.details?.missing,
      reference: e.referenceId,
    });
    back.searchParams.set("error", e.code);
    back.searchParams.set("ref", e.referenceId);
    if (reason) back.searchParams.set("reason", reason);
  }
  return NextResponse.redirect(back);
}
