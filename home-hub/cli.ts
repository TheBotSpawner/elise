import { createInterface } from "node:readline/promises";

import { AGENT_VERSION, HubAgent } from "./agent";
import { EliseCloud } from "./cloud";
import { haTokenOf, isLocalProvider, loadConfig, saveConfig, type HubConfig } from "./config";
import { HomeAssistantClient } from "./home-assistant-client";
import { HOME_PROTOCOL_VERSION } from "../src/core/home/model";
import { normalizeRegistry } from "../src/infrastructure/home/home-assistant";

/**
 * ELISE Home Hub — developer CLI (ADR-079). The product host is ELISE Desktop (ADR-080), which
 * runs this same service in the background; these commands exist for development and support.
 *
 *   npm run home-hub -- setup    pair with ELISE (one-time code) and point at Home Assistant
 *   npm run home-hub -- start    run the hub (heartbeat, sync, commands)
 *   npm run home-hub -- status   what's configured (no secrets shown)
 *   npm run home-hub -- doctor   check every link: ELISE, Home Assistant, events, discovery
 */
const [command = "status"] = process.argv.slice(2);
const ok = (s: string) => console.log(`  ✓ ${s}`);
const fail = (s: string, fix: string) => console.log(`  ✗ ${s}\n      → ${fix}`);

async function setup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const current = await loadConfig();
  const eliseUrl =
    (await rl.question(`ELISE URL [${current?.eliseUrl ?? "http://localhost:3000"}]: `)) ||
    current?.eliseUrl ||
    "http://localhost:3000";
  const haUrl =
    (await rl.question(`Home Assistant URL [${current?.haUrl ?? "http://localhost:8123"}]: `)) ||
    current?.haUrl ||
    "http://localhost:8123";
  if (!isLocalProvider(haUrl)) {
    rl.close();
    throw new Error("Home Assistant must be on this machine or the local network.");
  }
  const haToken = process.env.HA_TOKEN
    ? undefined
    : (await rl.question("Home Assistant long-lived token (or set HA_TOKEN): ")) ||
      current?.haToken;
  const code = await rl.question("Pairing code from ELISE › Hogar (ELISE-XXXX-XXXX): ");
  rl.close();
  const paired = await new EliseCloud(eliseUrl, null).pair(code, {
    name: "ELISE Home Hub (dev)",
    agentVersion: AGENT_VERSION,
    protocolVersion: HOME_PROTOCOL_VERSION,
  });
  await saveConfig({
    eliseUrl,
    haUrl,
    hubId: paired.hubId,
    homeId: paired.homeId,
    hubToken: paired.token,
    ...(haToken ? { haToken } : {}),
  });
  console.log("Paired. Run: npm run home-hub -- start");
}

async function requireConfig(): Promise<HubConfig & { hubToken: string }> {
  const c = await loadConfig();
  if (!c?.hubToken) throw new Error("Not paired yet. Run: npm run home-hub -- setup");
  if (!isLocalProvider(c.haUrl)) throw new Error("The configured Home Assistant isn't local.");
  return c as HubConfig & { hubToken: string };
}

async function start() {
  const c = await requireConfig();
  const token = haTokenOf(c);
  if (!token) throw new Error("No Home Assistant token: set HA_TOKEN or run setup again.");
  const agent = new HubAgent(c, token);
  process.on("SIGINT", () => {
    agent.stop();
    process.exit(0);
  });
  await agent.start();
}

async function status() {
  const c = await loadConfig();
  if (!c) return console.log("Not configured. Run: npm run home-hub -- setup");
  console.log(
    `ELISE: ${c.eliseUrl}\nHome Assistant: ${c.haUrl}\nPaired: ${c.hubToken ? "yes" : "no"} (hub ${c.hubId ?? "—"})\nAgent ${AGENT_VERSION} · protocol ${HOME_PROTOCOL_VERSION}`,
  );
}

async function doctor() {
  console.log("ELISE Home Hub — diagnostics");
  const c = await loadConfig();
  if (!c) return fail("No configuration", "Run: npm run home-hub -- setup");
  ok("Configuration found");
  if (!isLocalProvider(c.haUrl))
    fail("Home Assistant URL isn't local", "Use localhost or a local-network address");
  else ok("Home Assistant URL is local");
  // ELISE reachability + hub credential
  try {
    await new EliseCloud(c.eliseUrl, c.hubToken ?? null).heartbeat({
      providerConnected: false,
      runtimeState: "initializing",
      providerVersion: null,
      agentVersion: AGENT_VERSION,
      protocolVersion: HOME_PROTOCOL_VERSION,
    });
    ok("ELISE reachable and hub credential accepted");
  } catch (e) {
    const s = (e as { status?: number }).status;
    fail(
      `ELISE: ${(e as Error).message}`,
      s === 401
        ? "Pair again: npm run home-hub -- setup"
        : "Check the internet connection and the ELISE URL",
    );
  }
  const token = haTokenOf(c);
  if (!token) return fail("No Home Assistant token", "Set HA_TOKEN or run setup again");
  const ha = new HomeAssistantClient(c.haUrl, token);
  try {
    const p = await ha.ping();
    if (p.ok) ok("Home Assistant API reachable, token accepted");
    else
      return fail(
        `Home Assistant answered ${p.status}`,
        p.status === 401 ? "Create a new long-lived token" : "Check Home Assistant is running",
      );
  } catch {
    return fail("Can't reach Home Assistant", `Is it running at ${c.haUrl}?`);
  }
  try {
    await ha.connect();
    ok(`WebSocket API connected (Home Assistant ${ha.version ?? "?"})`);
    await ha.subscribeStates(() => undefined);
    ok("State events subscribed");
    const [states, entries] = await Promise.all([ha.states(), ha.entityRegistry()]);
    const names = await ha.names([
      ...new Set(entries.map((e) => e.device_id).filter((d): d is string => Boolean(d))),
    ]);
    const reg = normalizeRegistry(states, entries, names);
    ok(
      `Discovery: ${reg.devices.length} devices, ${reg.rooms.length} rooms (from ${states.length} entities)`,
    );
  } catch (e) {
    fail(
      `Home Assistant: ${(e as Error).message}`,
      "Check the token's user can read states and the entity registry",
    );
  } finally {
    ha.close();
  }
}

const commands: Record<string, () => Promise<void>> = { setup, start, status, doctor };
const run = commands[command];
if (!run) {
  console.log("Usage: npm run home-hub -- setup | start | status | doctor");
  process.exit(1);
}
run().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
