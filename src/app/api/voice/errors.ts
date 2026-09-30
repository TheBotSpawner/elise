import { NextResponse } from "next/server";

import { AppError, toAppError, toPublicError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";

const STATUS: Partial<Record<AppError["code"], number>> = {
  AUTH_ERROR: 401,
  PERMISSION_DENIED: 403,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  AI_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 502,
};

export function voiceError(error: unknown, route: string) {
  const appError = toAppError(error);
  if (appError.code === "INTERNAL_ERROR")
    logger.error("voice.request_failed", { route, reference: appError.referenceId });
  return NextResponse.json(
    { error: toPublicError(appError) },
    { status: STATUS[appError.code] ?? 500 },
  );
}

export const unauthorized = () =>
  new AppError("AUTH_ERROR", "Please sign in", { recovery: "sign_in" });
