import { NextResponse } from "next/server";

import { serverEnv } from "@/config/server-env";
import { readiness } from "@/infrastructure/health";

export const dynamic = "force-dynamic";

/**
 * Deployment health and readiness (ADR-019). 200 when ELISE can serve users (database and
 * auth reachable), 503 otherwise, for uptime monitors. Optional capabilities report their
 * state without failing the check. Never returns secrets, values or user data.
 */
export async function GET() {
  const { ready, domains, invalidConfig } = await readiness();
  return NextResponse.json(
    {
      status: ready ? "ok" : "unavailable",
      environment: serverEnv().ELISE_ENV,
      checks: domains,
      ...(invalidConfig.length ? { invalidConfig } : {}),
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
