import type { NextRequest } from "next/server";

import { getAuthContext } from "@/application/auth-context";
import { transcribeUtterance } from "@/application/voice-service";
import { AppError } from "@/core/errors";

import { unauthorized, voiceError } from "../errors";

export const maxDuration = 30;

/** One recorded utterance (multipart `audio`) → NDJSON transcript events. Audio isn't stored. */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    if (!auth) throw unauthorized();
    const form = await request.formData().catch(() => null);
    const audio = form?.get("audio");
    if (!(audio instanceof File)) throw new AppError("VALIDATION_ERROR", "Missing audio");
    const stream = await transcribeUtterance(auth, audio);
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return voiceError(error, "transcribe");
  }
}
