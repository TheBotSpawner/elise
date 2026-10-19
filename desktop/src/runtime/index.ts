import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { homeActionInputSchema } from "@/core/home/model";
import {
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  localHomeCommandSchema,
  type HomeHubLocalState,
} from "@/core/platform/platform";

import type { HomeRuntimeBackend } from "./home-runtime/backend";
import {
  HomeRuntimeManager,
  type PersistedRuntime,
  type RuntimeStore,
} from "./home-runtime/manager";
import { ExternalBackend, UnsupportedBackend } from "./home-runtime/other-backends";
import { WslContainerBackend } from "./home-runtime/wsl-backend";
import { AGENT_VERSION, HubAgent } from "../../../home-hub/agent";
import { isLocalProvider } from "../../../home-hub/config";

/**
 * ELISE Local Runtime (ADR-081/082): local capabilities in their own process, supervised by
 * the Desktop main process and independent of any window — closing or crashing the window
 * never stops the home. It hosts local.home: the managed Home runtime (provision, start,
 * health, updates) and, once that's ready, the Home Hub agent that links it to ELISE Cloud.
 * The message protocol has no Electron types, so this can become an OS service later.
 */
const configSchema = z.object({
  cloudUrl: z.string().url(),
  hubToken: z.string().nullable(),
  dataDir: z.string().min(3),
  timezone: z.string().max(64),
  language: z.string().max(8),
  /** Development: an existing engine instead of the managed one. */
  external: z.object({ haUrl: z.string(), haToken: z.string() }).nullable(),
  /** Credentials ELISE created on its managed engine (from Desktop's encrypted store). */
  engine: z.object({ haUrl: z.string(), haToken: z.string() }).nullable(),
});
type Config = z.infer<typeof configSchema>;
type Message = { id: number; method: string; params?: unknown };

const port = process.parentPort;
const send = (m: unknown) => port.postMessage(m);
const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

let config: Config | null = null;
let manager: HomeRuntimeManager | null = null;
let agent: HubAgent | null = null;
let agentKey = "";

function fileStore(dir: string): RuntimeStore {
  const file = join(dir, "state.json");
  return {
    load: () => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as PersistedRuntime;
      } catch {
        return null; // missing or corrupt: start clean, never stuck
      }
    },
    save: (s) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2));
      renameSync(`${file}.tmp`, file);
    },
  };
}

function backendFor(c: Config): HomeRuntimeBackend {
  if (c.external) return new ExternalBackend({ ...c.external, ownerPassword: null });
  if (process.platform === "win32")
    return new WslContainerBackend(c.dataDir, c.timezone, undefined, log);
  return new UnsupportedBackend();
}

const engineCreds = () => config?.external ?? config?.engine ?? null;

function state(): HomeHubLocalState {
  const s = agent?.status();
  return {
    runtime: manager!.status(),
    paired: Boolean(config?.hubToken),
    providerConnected: s?.providerConnected ?? false,
    devices: s?.devices ?? 0,
  };
}
const publish = () => manager && send({ event: "home", state: state() });

/** Engine ready + credentials → the hub agent runs (restarted when its inputs change). */
function syncAgent() {
  const creds = engineCreds();
  const ready = manager?.status().phase === "ready";
  const key =
    ready && creds && config ? `${creds.haUrl}|${creds.haToken}|${config.hubToken ?? ""}` : "";
  if (key === agentKey) return;
  agent?.stop();
  agent = null;
  agentKey = key;
  if (!key || !creds || !config || !isLocalProvider(creds.haUrl)) return;
  agent = new HubAgent(
    { eliseUrl: config.cloudUrl, haUrl: creds.haUrl, hubToken: config.hubToken ?? "" },
    creds.haToken,
  );
  void agent.start().catch((e) => log("home_agent_failed", { message: (e as Error).message }));
}

async function configure(raw: unknown) {
  const next = configSchema.parse(raw);
  const backendChanged =
    !config ||
    config.dataDir !== next.dataDir ||
    Boolean(config.external) !== Boolean(next.external);
  config = next;
  if (backendChanged) {
    manager?.dispose();
    mkdirSync(next.dataDir, { recursive: true });
    manager = new HomeRuntimeManager(backendFor(next), fileStore(next.dataDir), {
      language: next.language,
      hasCredentials: () => engineCreds() !== null,
    });
    manager.on("status", () => {
      syncAgent();
      publish();
    });
    manager.on("credentials", (creds) => {
      // Straight to Desktop's OS-encrypted store; never logged, never written here.
      config = config
        ? { ...config, engine: { haUrl: creds.haUrl, haToken: creds.haToken } }
        : config;
      send({ event: "credentials", creds });
      syncAgent();
    });
    // The development engine counts as "enabled" from the start.
    if (next.external && !manager.status().enabled) void manager.setup();
    else void manager.init();
  }
  syncAgent();
  publish();
}

// The agent's own link (provider connected, devices) changes on its own: keep the UI in step.
let last = "";
setInterval(() => {
  if (!manager) return;
  const s = JSON.stringify(state());
  if (s !== last) {
    last = s;
    publish();
  }
}, 2000);

const need = () => {
  if (!manager) throw new Error("runtime not configured");
  return manager;
};

const handlers: Record<string, (params: unknown) => unknown> = {
  hello: () => ({ protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION, version: AGENT_VERSION }),
  configure,
  homeState: () => (manager ? state() : null),
  // Long operations run in the background; progress arrives as "home" events.
  setup: () => void need().setup(),
  enableRequirements: () => void need().enableRequirements(),
  start: () => void need().start(),
  stop: () => need().stop(),
  update: () => void need().update(),
  reset: async () => {
    agent?.stop();
    agent = null;
    agentKey = "";
    await need().reset();
    if (config) config = { ...config, engine: null };
    return true;
  },
  diagnostics: () => need().diagnostics(),
  listDevices: () => agent?.localDevices() ?? [],
  // ADR-090: what the engine found on the network, and adding it (named actions only).
  homeDiscoveries: () => agent?.discoveries() ?? [],
  homeDiscoveryOpen: (params) => {
    const { flowId } = z.object({ flowId: z.string().max(64) }).parse(params);
    if (!agent) return { kind: "aborted", reason: "home_not_running" };
    return agent.openDiscovery(flowId);
  },
  homeDiscoveryAnswer: (params) => {
    const { flowId, answers } = z
      .object({
        flowId: z.string().max(64),
        answers: z.record(
          z.string().max(64),
          z.union([z.string().max(500), z.number(), z.boolean()]),
        ),
      })
      .parse(params);
    if (!agent) return { kind: "aborted", reason: "home_not_running" };
    return agent.answerDiscovery(flowId, answers);
  },
  homeDiscoveryIgnore: async (params) => {
    const { flowId, name } = z
      .object({ flowId: z.string().max(64), name: z.string().max(80) })
      .parse(params);
    await agent?.ignoreDiscovery(flowId, name);
    return true;
  },
  execute: async (params) => {
    const c = localHomeCommandSchema.parse(params);
    if (!agent) return { ok: false, error: "HOME_NOT_RUNNING" };
    const inputs = z.array(homeActionInputSchema).parse(c.actions);
    return agent.executeLocal(c.providerKey, inputs);
  },
  shutdown: async () => {
    agent?.stop();
    // Explicit quit: the engine stops with ELISE (it starts again with ELISE).
    await manager?.stop().catch(() => undefined);
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
