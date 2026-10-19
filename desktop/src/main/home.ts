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
/** This computer's short name ("PC-CASA"): shown only to its owner (RLS), never the FQDN. */
export const computerName = () => hostname().split(".")[0]!.trim().slice(0, 40) || "ELISE Desktop";
const deviceName = () => `ELISE Desktop (${computerName().slice(0, 24)})`;

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

let registering: Promise<void> | null = null;

/**
 * Links this computer as the home's hub — once at a time. It used to run for every runtime
 * event: two overlapping registrations created two hubs and the second revoked the first, and
 * when the runtime kept the revoked credential, Hogar showed the hub offline for good.
 */
function registerHub(host: RuntimeHost): Promise<void> {
  registering ??= doRegisterHub(host).finally(() => (registering = null));
  return registering;
}

async function doRegisterHub(host: RuntimeHost) {
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
  // ELISE Cloud refused this hub's credential (revoked elsewhere, or lost): forget it and link
  // again, at most once a minute so a cloud problem never turns into a registration loop.
  let lastRelink = 0;
  host.on("hubRejected", () => {
    if (!hubToken() || Date.now() - lastRelink < 60_000) return;
    lastRelink = Date.now();
    log("desktop_home_credential_rejected");
    setHubToken(null, null);
    void host
      .configure(runtimeConfig())
      .catch(() => undefined)
      .then(() => registerHub(host));
  });
}

/** "Quitar ELISE Home de esta computadora": engine and its data go; the account stays. */
export async function resetHome(host: RuntimeHost) {
  await host.call("reset", undefined, 10 * 60_000);
  setEngineCredentials(null);
  await host.configure(runtimeConfig());
}
