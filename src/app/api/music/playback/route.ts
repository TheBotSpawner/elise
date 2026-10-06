import { NextResponse } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { currentMusic } from "@/application/music-service";
import { toPublicError } from "@/core/errors";

/**
 * What the user's music provider is playing now (ADR-042): the page polls it so the Music
 * Surface and the mini-player follow changes made in the provider's own app. 204: no music
 * provider whose state lives outside the page.
 */
export async function GET() {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Please sign in" }, { status: 401 });
  try {
    const music = await currentMusic(auth);
    if (!music) return new NextResponse(null, { status: 204 });
    return NextResponse.json(music, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e }, { status: e.code === "AUTH_EXPIRED" ? 409 : 502 });
  }
}
