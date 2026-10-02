import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { persistLiveTurns } from "@/application/live-voice-service";
import { AppError } from "@/core/errors";

import { unauthorized, voiceError } from "../../errors";

const body = z
  .object({
    conversationId: z.uuid().nullable().optional(),
    sessionId: z.uuid().nullable(),
    turns: z
      .array(
        z
          .object({ role: z.enum(["user", "assistant"]), text: z.string().trim().max(4000) })
          .strict(),
      )
      .max(20),
  })
  .strict();

/** Settled conversational turns GPT-Live handled itself → the voice session (History, Recall). */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    if (!auth) throw unauthorized();
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid turns");
    const sessionId = await persistLiveTurns(auth, parsed.data);
    return NextResponse.json({ sessionId });
  } catch (error) {
    return voiceError(error, "live.turns");
  }
}
