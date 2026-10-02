import "server-only";

import { isSupabaseConfigured, supabasePublicConfig } from "@/config/env";
import { invalidEnvKeys, serverEnv } from "@/config/server-env";
import { isGoogleConfigured } from "@/infrastructure/providers/google/config";
import { isNotionConfigured } from "@/infrastructure/providers/notion/oauth";

/**
 * Internal health model (ADR-019). One place that knows which parts of ELISE can work right
 * now, so the product avoids impossible workflows and the health check reports readiness.
 * Never exposes secrets, values or provider internals — only states.
 */
export type HealthDomain =
  "database" | "auth" | "ai" | "web" | "voice" | "background" | "google" | "notion" | "encryption";

export type DomainState = "ready" | "not_configured" | "down";

/** Without these ELISE cannot serve anyone; the rest only disable their own features. */
export const REQUIRED: readonly HealthDomain[] = ["database", "auth"];

export function configuredDomains(): Record<HealthDomain, DomainState> {
  const env = serverEnv();
  const state = (ok: boolean): DomainState => (ok ? "ready" : "not_configured");
  const supabase = isSupabaseConfigured();
  return {
    database: state(supabase),
    auth: state(supabase),
    ai: state(Boolean(env.OPENAI_API_KEY)),
    web: state(Boolean(env.TAVILY_API_KEY || env.OPENAI_API_KEY)),
    voice: state(Boolean(env.OPENAI_API_KEY)),
    background: state(Boolean(env.TRIGGER_SECRET_KEY)),
    google: state(isGoogleConfigured()),
    notion: state(isNotionConfigured()),
    encryption: state(Boolean(env.ELISE_ENCRYPTION_KEY && env.SUPABASE_SECRET_KEY)),
  };
}

/** Liveness of the database and auth: Supabase's own health endpoint, bounded to 3 s. */
async function supabaseReachable(): Promise<boolean> {
  try {
    const { url, publishableKey } = supabasePublicConfig();
    const res = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: publishableKey },
      signal: AbortSignal.timeout(3_000),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function readiness(): Promise<{
  ready: boolean;
  domains: Record<HealthDomain, DomainState>;
  invalidConfig: string[];
}> {
  const domains = configuredDomains();
  if (domains.database === "ready" && !(await supabaseReachable())) {
    domains.database = "down";
    domains.auth = "down";
  }
  return {
    ready: REQUIRED.every((d) => domains[d] === "ready"),
    domains,
    invalidConfig: invalidEnvKeys(),
  };
}
