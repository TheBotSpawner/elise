import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { runDelegation } from "@/application/live-voice-service";
import { AppError, toAppError, toPublicError } from "@/core/errors";

import { unauthorized, voiceError } from "../../errors";

export const maxDuration = 60;

const body = z
  .object({
    delegationId: z.string().min(1).max(200),
    conversationId: z.uuid().nullable(),
    sessionId: z.uuid().nullable(),
    text: z.string().trim().min(1).max(4000),
    /** The user's position, only while they share it (ADR-023/028); coarse, never stored. */
    here: z
      .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * GPT-Live client delegation (ADR-026): the request the voice model handed over, run through
 * ELISE's turn engine. Streams the same events as chat (Canvas, activity, text) and ends with
 * the compact result the voice model speaks from. Closing the request cancels the work.
 */
export async function POST(request: NextRequest) {
  const receivedAt = Date.now();
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
    const auth = await getAuthContext();
    if (!auth) throw unauthorized();
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid delegation");
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: unknown) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        try {
          await runDelegation(
            auth,
            { ...parsed.data, requestId, receivedAt },
            send,
            request.signal,
          );
        } catch (error) {
          send({ type: "error", error: toPublicError(toAppError(error)) });
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    return error instanceof AppError && error.code === "CONFLICT"
      ? NextResponse.json({ error: toPublicError(error) }, { status: 409 })
      : voiceError(error, "live.delegate");
  }
}
