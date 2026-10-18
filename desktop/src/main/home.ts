import { hostname } from "node:os";

import { HOME_PROTOCOL_VERSION } from "@/core/home/model";

import { cloudFetch, cloudState, hubToken, session, setHubToken } from "./cloud";
import { log } from "./log";
import type { RuntimeHost } from "./runtime-host";
import { loadState } from "./store";

/**
 * ELISE Home on this computer (ADR-080/081). The local Home Assistant runtime is internal: in
 * this version it is one already running on this machine or network (ELISE_HA_URL + HA_TOKEN);
 * the managed runtime ELISE installs itself is the next step (see ADR-081, "Open decision").
 * When there is a runtime and the person is signed in, Desktop registers itself as the home's
 * hub once and keeps that credential (OS-encrypted) across updates and restarts.
 */
function localRuntimeConfig() {
  return { haUrl: process.env.ELISE_HA_URL ?? null, haToken: process.env.HA_TOKEN ?? null };
}

/** A friendly default name, without exposing the full host name. */
const deviceName = () => {
  const short = hostname().split(".")[0]!.slice(0, 24);
  return short ? `ELISE Desktop (${short})` : "ELISE Desktop";
};

export async function configureHome(host: RuntimeHost) {
  const { haUrl, haToken } = localRuntimeConfig();
  let token = hubToken();
  const s = session();
  if (haUrl && haToken && !token && s.signedIn && cloudState().cloud === "online") {
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
      if (res.ok) {
        token = ((await res.json()) as { token: string }).token;
        setHubToken(token, s.workspaceId);
        log("desktop_home_registered");
      } else log("desktop_home_register_failed", { status: res.status });
    } catch (e) {
      log("desktop_home_register_failed", { message: (e as Error).message });
    }
  }
  await host
    .configure({ cloudUrl: __ELISE_BUILD__.cloudUrl, hubToken: token, haUrl, haToken })
    .catch((e) => log("desktop_home_configure_failed", { message: (e as Error).message }));
}
