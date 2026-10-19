import { app } from "electron";
import { hostname } from "node:os";
import { join } from "node:path";

import { HOME_PROTOCOL_VERSION } from "@/core/home/model";

import {
  cloudFetch,
  cloudState,
  engineCredentials,
  hubToken,
  session,
  setEngineCredentials,
  setHubToken,
} from "./cloud";
import { log } from "./log";
import type { RuntimeHost } from "./runtime-host";
import { loadState } from "./store";

/**
 * ELISE Home on this computer (ADR-080/081/082). The local runtime provisions and runs ELISE's
 * own engine (Home Assistant Container on WSL2, managed — never installed by the person); its
 * credentials come back here and are kept OS-encrypted. Once the engine is ready and someone is
 * signed in, Desktop registers itself as the home's hub once, across updates and restarts.
 */
export const homeRuntimeDir = () => join(app.getPath("userData"), "home-runtime");

/** Development only: an engine already running elsewhere (never in a packaged app). */
function externalEngine() {
  const haUrl = process.env.ELISE_HA_URL;
  const haToken = process.env.HA_TOKEN;
  return !app.isPackaged && haUrl && haToken ? { haUrl, haToken } : null;
}

/** A friendly default name, without exposing the full host name. */
const deviceName = () => {
  const short = hostname().split(".")[0]!.slice(0, 24);
  return short ? `ELISE Desktop (${short})` : "ELISE Desktop";
};

export function runtimeConfig() {
  const engine = engineCredentials();
  return {
    cloudUrl: __ELISE_BUILD__.cloudUrl,
    hubToken: hubToken(),
    dataDir: homeRuntimeDir(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    language: app.getLocale().slice(0, 2),
    external: externalEngine(),
    engine: engine ? { haUrl: engine.haUrl, haToken: engine.haToken } : null,
  };
}

async function registerHub(host: RuntimeHost) {
  const s = session();
  if (hubToken() || !s.signedIn || cloudState().cloud !== "online") return;
  if (host.home?.runtime.phase !== "ready") return;
  try {
    const res = await cloudFetch("/api/home/desktop/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: deviceName(),
        agentVersion: host.version ?? undefined,
        protocolVersion: HOME_PROTOCOL_VERSION,
        installationId: loadState().installationId,
      }),
    });
    if (!res.ok) return log("desktop_home_register_failed", { status: res.status });
    setHubToken(((await res.json()) as { token: string }).token, s.workspaceId);
    log("desktop_home_registered");
    await host.configure(runtimeConfig());
  } catch (e) {
    log("desktop_home_register_failed", { message: (e as Error).message });
  }
}

/** (Re)configure the runtime and link the hub when everything is in place. */
export async function configureHome(host: RuntimeHost) {
  await host
    .configure(runtimeConfig())
    .catch((e) => log("desktop_home_configure_failed", { message: (e as Error).message }));
  await registerHub(host);
}

export function watchHome(host: RuntimeHost) {
  host.on(
    "credentials",
    (creds: { haUrl: string; haToken: string; ownerPassword: string | null }) => {
      setEngineCredentials(creds);
      log("desktop_home_engine_credentials_saved");
    },
  );
  host.on("home", () => void registerHub(host));
}

/** "Quitar ELISE Home de esta computadora": engine and its data go; the account stays. */
export async function resetHome(host: RuntimeHost) {
  await host.call("reset", undefined, 10 * 60_000);
  setEngineCredentials(null);
  await host.configure(runtimeConfig());
}
