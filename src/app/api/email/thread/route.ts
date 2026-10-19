import { NextResponse, type NextRequest } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { readThread } from "@/application/email-service";
import { toPublicError } from "@/core/errors";

/**
 * One email conversation for ELISE's reader (ADR-098), fetched when it opens: the provider's
 * plain text, never markup. The thread id is opaque and routes to the user's own account; a
 * thread of another workspace simply doesn't resolve.
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthContext();
  if (!auth) return NextResponse.json({ error: "Please sign in" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id || id.length > 1000)
    return NextResponse.json({ error: "A thread id is required" }, { status: 400 });
  try {
    const thread = await readThread(auth, id);
    if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ thread }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const e = toPublicError(error);
    const status =
      e.code === "NOT_FOUND"
        ? 404
        : e.code === "AUTH_EXPIRED" || e.code === "AUTH_ERROR"
          ? 409
          : e.code === "PERMISSION_DENIED" || e.code === "VALIDATION_ERROR"
            ? 403
            : 502;
    return NextResponse.json({ error: e }, { status });
  }
}
