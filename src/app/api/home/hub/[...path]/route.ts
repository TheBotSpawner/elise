import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";

import {
  authenticateHub,
  hubClaimCommands,
  hubHeartbeat,
  hubReportResult,
  hubStates,
  hubSync,
  redeemPairingCode,
} from "@/application/home-service";
import { AppError, toAppError, toPublicError } from "@/core/errors";
import { HOME_PROTOCOL_VERSION } from "@/core/home/model";
import { logger } from "@/infrastructure/observability/logger";
import { rateLimit } from "@/infrastructure/rate-limit";

export const dynamic = "force-dynamic";
// Long polls wait up to 25 s for a command.
export const maxDuration = 60;

/**
 * The ELISE Home Hub's channel (ADR-079): the agent at home calls out over HTTPS — nothing at
 * home is ever exposed. Every call but `pair` carries the hub's own bearer token (never a user
 * session); the server scopes every statement to that hub's workspace and home.
 *
 *   POST pair · POST heartbeat · POST sync · POST states · GET commands?wait=25 ·
 *   POST commands/{id}
 */
const STATUS: Partial<Record<AppError["code"], number>> = {
  AUTH_ERROR: 401,
  PERMISSION_DENIED: 403,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  CAPABILITY_UNAVAILABLE: 503,
};

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(request: NextRequest, ctx: Ctx, method: "GET" | "POST") {
  try {
    const { path } = await ctx.params;
    const [first, second] = path;
    const body = method === "POST" ? await request.json().catch(() => null) : null;
    if (method === "POST" && first === "pair" && !second) {
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
      rateLimit(
        `home.pair:${ip}`,
        10,
        10 * 60_000,
        "Too many pairing attempts. Wait a few minutes.",
      );
      return NextResponse.json({
        ...(await redeemPairingCode(body)),
        protocolVersion: HOME_PROTOCOL_VERSION,
      });
    }
    const hub = await authenticateHub(request.headers.get("authorization"));
    rateLimit(`home.hub:${hub.id}`, 600, 60_000, "Too many hub requests.");
    if (method === "POST" && first === "heartbeat" && !second) {
      await hubHeartbeat(hub, body);
      return NextResponse.json({ ok: true, protocolVersion: HOME_PROTOCOL_VERSION });
    }
    if (method === "POST" && first === "sync" && !second)
      return NextResponse.json(await hubSync(hub, body));
    if (method === "POST" && first === "states" && !second) {
      await hubStates(hub, body);
      return NextResponse.json({ ok: true });
    }
    if (method === "GET" && first === "commands" && !second) {
      const wait = Number(request.nextUrl.searchParams.get("wait") ?? "0") * 1000;
      return NextResponse.json({
        commands: await hubClaimCommands(hub, Number.isFinite(wait) ? wait : 0),
      });
    }
    if (method === "POST" && first === "commands" && second) {
      await hubReportResult(hub, second, body);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Unknown hub route" } },
      { status: 404 },
    );
  } catch (error) {
    const appError =
      error instanceof ZodError
        ? new AppError("VALIDATION_ERROR", "Invalid hub payload")
        : toAppError(error);
    if (appError.code === "INTERNAL_ERROR")
      logger.error("home_hub_request_failed", {
        reference: appError.referenceId,
        cause: appError.cause,
      });
    return NextResponse.json(
      { error: toPublicError(appError) },
      { status: STATUS[appError.code] ?? 500 },
    );
  }
}

export const GET = (request: NextRequest, ctx: Ctx) => handle(request, ctx, "GET");
export const POST = (request: NextRequest, ctx: Ctx) => handle(request, ctx, "POST");
