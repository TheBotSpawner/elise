import type { NextRequest } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { synthesizeSentence } from "@/application/voice-service";
import { AppError } from "@/core/errors";
import { VOICE_DELIVERIES } from "@/core/voice/delivery";

import { unauthorized, voiceError } from "../errors";

export const maxDuration = 30;

const body = z
  .object({
    text: z.string().trim().min(1).max(1200),
    language: z.enum(["es", "en"]).nullable(),
    /** The segment said just before, so the voice continues its intonation (ADR-030). */
    previous: z.string().trim().max(1200).optional(),
    /** How to say it, decided by the voice runtime from the user's audio (ADR-049). */
    delivery: z.enum(VOICE_DELIVERIES).optional(),
  })
  .strict();

/** One sentence of ELISE's reply → streamed 16-bit PCM (played as it arrives). */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthContext();
    if (!auth) throw unauthorized();
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid speech request");
    const { stream, sampleRate, source } = await synthesizeSentence(
      auth,
      parsed.data.text,
      parsed.data.language,
      parsed.data.previous,
      parsed.data.delivery,
    );
    return new Response(stream, {
      headers: {
        "content-type": "application/octet-stream",
        "x-audio-format": `pcm_s16le;rate=${sampleRate}`,
        // ADR-104: provider:model:origin, for the voice diagnostics (no content).
        "x-speech-source": source,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return voiceError(error, "speak");
  }
}
