import { NextResponse } from "next/server";

import { exchangeDesktopCode } from "@/application/desktop-service";
import { rateLimit } from "@/infrastructure/rate-limit";

import { desktopError, requireDesktopClient } from "../respond";

export const dynamic = "force-dynamic";

/** ELISE Desktop redeems its single-use sign-in code with the PKCE verifier (ADR-081). */
export async function POST(request: Request) {
  try {
    requireDesktopClient(request);
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    rateLimit(`desktop.session:${ip}`, 10, 10 * 60_000, "Too many attempts. Wait a few minutes.");
    return NextResponse.json(await exchangeDesktopCode(await request.json().catch(() => null)));
  } catch (error) {
    return desktopError(error, "desktop_session_failed");
  }
}
