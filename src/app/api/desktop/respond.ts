import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { AppError, toAppError, toPublicError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";

const STATUS: Record<string, number> = {
  AUTH_ERROR: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  CAPABILITY_UNAVAILABLE: 503,
};

/** One error shape for every ELISE Desktop endpoint: public message, never internals. */
export function desktopError(error: unknown, event: string) {
  const e =
    error instanceof ZodError
      ? new AppError("VALIDATION_ERROR", "Invalid request")
      : toAppError(error);
  if (e.code === "INTERNAL_ERROR")
    logger.error(event, { reference: e.referenceId, cause: e.cause });
  return NextResponse.json({ error: toPublicError(e) }, { status: STATUS[e.code] ?? 500 });
}

/**
 * Desktop calls carry this header. A cross-site form can't set it (it forces a CORS preflight
 * nobody answers), so cookie-authenticated endpoints stay CSRF-safe.
 */
export function requireDesktopClient(request: Request) {
  if (request.headers.get("x-elise-client") !== "desktop")
    throw new AppError("PERMISSION_DENIED", "Not available here");
}
