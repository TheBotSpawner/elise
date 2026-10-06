import { NextResponse } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { spotifyPlayerToken } from "@/application/connections-service";

/**
 * A short-lived Spotify access token for ELISE's own player in this page (the Web Playback
 * SDK needs one in the browser). The signed-in user's own account only; never the refresh
 * token or the client secret.
 */
export async function GET() {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Please sign in" }, { status: 401 });
  const token = await spotifyPlayerToken(auth).catch(() => null);
  if (!token) return new NextResponse(null, { status: 404 });
  return NextResponse.json(token, { headers: { "cache-control": "no-store, private" } });
}
