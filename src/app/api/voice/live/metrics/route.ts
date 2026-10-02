import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { recordLiveMetrics } from "@/application/live-voice-service";

const ms = z.number().int().min(0).max(600_000);
const body = z
  .object({
    sessionId: z.uuid().nullable(),
    liveSessionId: z.string().min(1).max(200),
    usageSeconds: z.number().min(0).max(86_400).optional(),
    connectMs: ms.optional(),
    firstAudioMs: z.array(ms).max(200).optional(),
    interruptStopMs: z.array(ms).max(200).optional(),
    delegations: z.number().int().min(0).max(1000).optional(),
    closeReason: z.string().max(40).optional(),
  })
  .strict();

/** GPT-Live session timings and usage (numbers only). Best effort: never fails the client. */
export async function POST(request: NextRequest) {
  const auth = await getAuthContext();
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (auth && parsed.success) {
    const { sessionId, ...metrics } = parsed.data;
    await recordLiveMetrics(auth, sessionId, metrics).catch(() => undefined);
  }
  return new NextResponse(null, { status: 204 });
}
