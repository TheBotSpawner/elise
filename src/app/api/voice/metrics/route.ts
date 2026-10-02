import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getAuthContext } from "@/application/auth-context";
import { recordVoiceTimings, VOICE_TIMINGS } from "@/application/voice-service";

const ms = z.number().int().min(0).max(300_000);
// Known timings are kept, anything else the client measures is dropped (not a reason to lose
// the whole record: `.strict()` rejected every turn, since the client sends more marks).
const body = z.object(Object.fromEntries(VOICE_TIMINGS.map((k) => [k, ms.optional()])));

/** Latency of one voice turn (numbers only). Best effort: never fails the client. */
export async function POST(request: NextRequest) {
  const auth = await getAuthContext();
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (auth && parsed.success) recordVoiceTimings(auth, parsed.data);
  return new NextResponse(null, { status: 204 });
}
