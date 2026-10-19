import "server-only";

import type { AuthContext } from "@/application/auth-context";
import { listDesktops } from "@/application/desktop-service";
import { homeSnapshot } from "@/application/home-service";
import { desktopReleaseFor, platformFromUserAgent } from "@/config/desktop-releases";
import { serverEnv } from "@/config/server-env";
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

/**
 * Hogar's data, shared by the web page and ELISE Desktop (ADR-081/082): the home, the person's
 * computers (presence), and the Desktop build for the browser's platform when there is one.
 */
export async function homeHubPageProps(auth: AuthContext, userAgent: string | null = null) {
  const platform = platformFromUserAgent(userAgent);
  const [snapshot, desktops, release] = await Promise.all([
    // A database without migration 049 yet: the setup screen, never an error page.
    homeSnapshot(auth).catch((error) => {
      if (error instanceof AppError && error.code === "CAPABILITY_UNAVAILABLE") return EMPTY;
      throw error;
    }),
    listDesktops(auth).catch(() => []),
    platform ? desktopReleaseFor(platform).catch(() => null) : null,
  ]);
  return {
    snapshot,
    desktops,
    download: release
      ? {
          platform: release.platform,
          arch: release.arch,
          version: release.version,
          url: release.installerUrl,
          sizeBytes: release.sizeBytes ?? null,
          beta: release.channel === "beta",
        }
      : null,
    platform,
    // Developer pairing (the CLI hub) never shows to people in production.
    devTools: serverEnv().ELISE_ENV === "development",
    workspaceId: auth.workspaceId,
    timezone: auth.profile.timezone,
  };
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
