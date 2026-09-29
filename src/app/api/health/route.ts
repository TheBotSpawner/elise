import { NextResponse } from "next/server";

import { isSupabaseConfigured } from "@/config/env";
import { serverEnv } from "@/config/server-env";

export const dynamic = "force-dynamic";

/** Engineering health: which subsystems are configured. Never returns secrets or user data. */
export function GET() {
  const env = serverEnv();
  return NextResponse.json({
    status: "ok",
    environment: env.ELISE_ENV,
    checks: {
      database: isSupabaseConfigured() ? "configured" : "not_configured",
      ai: env.OPENAI_API_KEY ? "configured" : "not_configured",
      background: env.TRIGGER_SECRET_KEY ? "configured" : "not_configured",
    },
  });
}
