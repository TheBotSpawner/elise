import "server-only";

import type { AuthContext } from "@/application/auth-context";
import { homeSnapshot } from "@/application/home-service";
import { AppError } from "@/core/errors";
import type { HomeSnapshot } from "@/core/home/model";

const EMPTY: HomeSnapshot = {
  home: null,
  hub: null,
  rooms: [],
  devices: [],
  groups: [],
  scenes: [],
};

/** Hogar's data, shared by the web page and ELISE Desktop (ADR-081). */
export async function homeHubPageProps(auth: AuthContext) {
  // A database without migration 049 yet: the setup screen, never an error page.
  const snapshot = await homeSnapshot(auth).catch((error) => {
    if (error instanceof AppError && error.code === "CAPABILITY_UNAVAILABLE") return EMPTY;
    throw error;
  });
  return { snapshot, workspaceId: auth.workspaceId, timezone: auth.profile.timezone };
}

/**
 * Desktop only: which provider device each ELISE device is, so the local runtime can still
 * control it when ELISE Cloud is unreachable (ADR-081). Not secret; never shown.
 */
export async function homeProviderKeys(auth: AuthContext): Promise<Record<string, string>> {
  const { data } = await auth.db
    .from("home_devices")
    .select("id, provider_key")
    .eq("workspace_id", auth.workspaceId)
    .is("removed_at", null);
  return Object.fromEntries((data ?? []).map((d) => [d.id, d.provider_key]));
}
