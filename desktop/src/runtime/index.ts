import { z } from "zod";

import { homeActionInputSchema } from "@/core/home/model";
import {
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  localHomeCommandSchema,
  type HomeHubLocalState,
} from "@/core/platform/platform";

import { AGENT_VERSION, HubAgent } from "../../../home-hub/agent";
import { isLocalProvider } from "../../../home-hub/config";

/**
 * ELISE Local Runtime (ADR-081): local capabilities in their own process, supervised by the
 * Desktop main process and independent of any window — a renderer crash or a closed window
 * never stops the home. Today it hosts one capability, local.home (the ELISE Home Hub,
 * ADR-079/080). The message protocol has no Electron types, so this process can later become a
 * real OS service without changing what the app asks for.
 */
const configSchema = z.object({
  cloudUrl: z.string().url(),
  hubToken: z.string().nullable(),
  haUrl: z.string().nullable(),
  haToken: z.string().nullable(),
});

type Message = { id: number; method: string; params?: unknown };

let agent: HubAgent | null = null;
let home: HomeHubLocalState = {
  runtime: "not_installed",
  paired: false,
  providerConnected: false,
  devices: 0,
  message: null,
};

const port = process.parentPort;
const send = (m: unknown) => port.postMessage(m);
const setHome = (patch: Partial<HomeHubLocalState>) => {
  home = { ...home, ...patch };
  send({ event: "home", state: home });
};

async function configure(raw: unknown) {
  const c = configSchema.parse(raw);
  agent?.stop();
  agent = null;
  if (!c.haUrl || !c.haToken)
    return setHome({ runtime: "not_installed", paired: Boolean(c.hubToken) });
  if (!isLocalProvider(c.haUrl))
    return setHome({
      runtime: "error",
      message: "The home runtime must be on this computer or network",
    });
  setHome({ runtime: "starting", paired: Boolean(c.hubToken), message: null });
  const a = new HubAgent(
    { eliseUrl: c.cloudUrl, haUrl: c.haUrl, hubToken: c.hubToken ?? "" },
    c.haToken,
  );
  agent = a;
  void a.start().catch((e) => setHome({ runtime: "error", message: String((e as Error).message) }));
}

// Health: the agent reconnects on its own; this only reports what it sees.
setInterval(() => {
  if (!agent) return;
  const s = agent.status();
  const runtime = s.providerConnected
    ? "ready"
    : home.runtime === "starting"
      ? "starting"
      : "degraded";
  if (
    runtime !== home.runtime ||
    s.devices !== home.devices ||
    s.providerConnected !== home.providerConnected
  )
    setHome({ runtime, devices: s.devices, providerConnected: s.providerConnected });
}, 2000);

const handlers: Record<string, (params: unknown) => unknown> = {
  hello: () => ({ protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION, version: AGENT_VERSION }),
  configure,
  homeState: () => home,
  listDevices: () => agent?.localDevices() ?? [],
  execute: async (params) => {
    const c = localHomeCommandSchema.parse(params);
    if (!agent) return { ok: false, error: "HOME_NOT_RUNNING" };
    const inputs = z.array(homeActionInputSchema).parse(c.actions);
    return agent.executeLocal(c.providerKey, inputs);
  },
  shutdown: () => {
    agent?.stop();
    setTimeout(() => process.exit(0), 50);
    return true;
  },
};

port.on("message", async (e: { data: Message }) => {
  const { id, method, params } = e.data;
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
  try {
    if (!handler) throw new Error(`Unknown method ${method}`);
    send({ id, ok: true, result: await handler(params) });
  } catch (error) {
    send({ id, ok: false, error: (error as Error).message.slice(0, 200) });
  }
});
