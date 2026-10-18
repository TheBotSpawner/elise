import { NextResponse } from "next/server";

import { requireAuthContext } from "@/application/auth-context";
import { desktopHeartbeat } from "@/application/desktop-service";

import { desktopError, requireDesktopClient } from "../respond";

export const dynamic = "force-dynamic";

/** Desktop presence (ADR-081): version, protocol and capabilities of this installation. */
export async function POST(request: Request) {
  try {
    requireDesktopClient(request);
    const auth = await requireAuthContext();
    return NextResponse.json(await desktopHeartbeat(auth, await request.json().catch(() => null)));
  } catch (error) {
    return desktopError(error, "desktop_heartbeat_failed");
  }
}
