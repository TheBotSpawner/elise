import type { NextRequest } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { previewVoice } from "@/application/voice-service";
import { AppError } from "@/core/errors";
import { VOICE_CHOICES } from "@/core/voice/providers";

import { unauthorized, voiceError } from "../errors";

const query = z.object({ voice: z.enum(VOICE_CHOICES), language: z.enum(["es", "en"]) }).strict();

/** Settings › Voice preview (ADR-030): a fixed ELISE sample in the chosen voice, as PCM. */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    if (!auth) throw unauthorized();
    const parsed = query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid preview request");
    const { stream, sampleRate } = await previewVoice(
      auth,
      parsed.data.voice,
      parsed.data.language,
    );
    return new Response(stream, {
      headers: {
        "content-type": "application/octet-stream",
        "x-audio-format": `pcm_s16le;rate=${sampleRate}`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return voiceError(error, "preview");
  }
}
