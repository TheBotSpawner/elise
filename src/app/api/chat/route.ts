import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { startChatTurn } from "@/application/chat-service";
import { AppError, toAppError, toPublicError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";

export const maxDuration = 60;

const bodySchema = z
  .object({
    conversationId: z.uuid().optional(),
    /** A voice session in progress (ADR-014). */
    sessionId: z.uuid().optional(),
    message: z.string().trim().min(1).max(8000),
    /** Knowledge Space a new conversation starts in ("Ask ELISE" from a Space). */
    spaceId: z.uuid().optional(),
    /** A spoken turn: its transcript is ordinary user input, with no extra authority. */
    modality: z.enum(["text", "voice"]).optional(),
    voice: z
      .object({
        durationMs: z.number().int().min(0).max(120_000),
        language: z.enum(["es", "en"]).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((b) => !(b.conversationId && b.sessionId), "One thread at a time");

const STATUS: Partial<Record<AppError["code"], number>> = {
  AUTH_ERROR: 401,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  AI_NOT_CONFIGURED: 503,
};

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
    const auth = await getAuthContext();
    if (!auth) throw new AppError("AUTH_ERROR", "Please sign in", { recovery: "sign_in" });

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Invalid message");

    const stream = await startChatTurn(auth, { ...parsed.data, requestId });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    const appError = toAppError(error);
    if (appError.code === "INTERNAL_ERROR") {
      logger.error("chat.request_failed", {
        request_id: requestId,
        reference: appError.referenceId,
        cause: appError.cause,
      });
    }
    return NextResponse.json(
      { error: toPublicError(appError) },
      { status: STATUS[appError.code] ?? 500 },
    );
  }
}
