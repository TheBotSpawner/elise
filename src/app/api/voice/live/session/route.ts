import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { createLiveSession } from "@/application/live-voice-service";
import { AppError } from "@/core/errors";

import { unauthorized, voiceError } from "../../errors";

export const maxDuration = 30;

const body = z.object({ sdp: z.string().min(10).max(100_000) }).strict();

/**
 * Starts a GPT-Live voice session (ADR-026): the browser's WebRTC offer in, GPT-Live's answer
 * out. ELISE's OpenAI key stays here; the session is bound to the signed-in user.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    if (!auth) throw unauthorized();
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid session request");
    const session = await createLiveSession(auth, parsed.data.sdp);
    return NextResponse.json({ sdp: session.sdp, liveSessionId: session.id }, { status: 201 });
  } catch (error) {
    return voiceError(error, "live.session");
  }
}
