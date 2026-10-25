import { NextResponse } from "next/server";

import { serverEnv } from "@/config/server-env";
import { logger } from "@/infrastructure/observability/logger";
import { brokerToken, verifyBrokerRequest } from "@/infrastructure/ocr/google-document-ai";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

/**
 * OCR token broker (ADR-121). Background jobs on Trigger.dev have no identity Google can trust,
 * so they ask here — on Vercel, which federates with Google without keys — for the OCR service
 * account's one-hour token. Only a request signed with OCR_BROKER_SECRET, within a minute, gets
 * one; the token only works for Document AI (the account's single role).
 */
export async function POST(request: Request) {
  const secret = serverEnv().OCR_BROKER_SECRET;
  const ok =
    secret &&
    verifyBrokerRequest(
      secret,
      request.headers.get("x-elise-at"),
      request.headers.get("x-elise-signature"),
    );
  if (!ok) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  try {
    const token = await brokerToken();
    if (!token)
      return NextResponse.json({ error: "not_configured" }, { status: 503, headers: NO_STORE });
    return NextResponse.json(token, { headers: NO_STORE });
  } catch (error) {
    logger.warn("ocr.broker_failed", { error: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "unavailable" }, { status: 502, headers: NO_STORE });
  }
}
