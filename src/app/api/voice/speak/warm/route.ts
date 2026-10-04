import type { NextRequest } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { warmAcknowledgements } from "@/application/voice-service";
import { AppError } from "@/core/errors";

import { unauthorized, voiceError } from "../../errors";

export const maxDuration = 60;

const body = z.object({ language: z.enum(["es", "en"]) }).strict();

/** Voice started: ELISE's acknowledgements, synthesized ahead in the user's voice (ADR-034). */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    if (!auth) throw unauthorized();
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid request");
    const made = await warmAcknowledgements(auth, parsed.data.language);
    return Response.json({ made }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return voiceError(error, "speak");
  }
}
