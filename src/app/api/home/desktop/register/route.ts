import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { registerDesktopHub } from "@/application/home-service";
import { AppError, toAppError, toPublicError } from "@/core/errors";
import { HOME_PROTOCOL_VERSION } from "@/core/home/model";
import { rateLimit } from "@/infrastructure/rate-limit";

export const dynamic = "force-dynamic";

/**
 * ELISE Desktop (signed in as the person) registers itself as the home's hub (ADR-080) and
 * receives a hub-only credential. The browser never calls this; nothing here is a user token.
 */
export async function POST(request: Request) {
  try {
    const auth = await getAuthContext();
    if (!auth) throw new AppError("AUTH_ERROR", "Please sign in", { recovery: "sign_in" });
    rateLimit(
      `home.desktop:${auth.userId}`,
      5,
      10 * 60_000,
      "Too many registrations. Wait a few minutes.",
    );
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({
      ...(await registerDesktopHub(auth, body)),
      protocolVersion: HOME_PROTOCOL_VERSION,
    });
  } catch (error) {
    const e =
      error instanceof ZodError
        ? new AppError("VALIDATION_ERROR", "Invalid request")
        : toAppError(error);
    const status = {
      AUTH_ERROR: 401,
      VALIDATION_ERROR: 400,
      RATE_LIMITED: 429,
      CAPABILITY_UNAVAILABLE: 503,
    }[e.code as string];
    return NextResponse.json({ error: toPublicError(e) }, { status: status ?? 500 });
  }
}
