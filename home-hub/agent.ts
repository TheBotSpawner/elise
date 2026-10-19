import { EliseCloud } from "./cloud";
import type { HubConfig } from "./config";
import { HomeAssistantClient } from "./home-assistant-client";
import {
  discoveredDevices,
  discoveryStep,
  isFlowId,
  stepAnswers,
  type DiscoveredDevice,
  type DiscoveryStep,
} from "../src/core/home/discovery";
import {
  HOME_PROTOCOL_VERSION,
  hubCommandSchema,
  validateAction,
  type HomeAction,
  type HomeActionInput,
  type HomeState,
  type HubCommand,
} from "../src/core/home/model";
import {
  normalizeRegistry,
  stateOf,
  toServiceCalls,
  type HaState,
  type SyncedDevice,
} from "../src/infrastructure/home/home-assistant";

export const AGENT_VERSION = "0.1.0";
const HEARTBEAT_MS = 20_000;
const RESYNC_MS = 10 * 60_000;

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

/**
 * The ELISE Home Hub service (ADR-079): the same loop ELISE Desktop will host. It keeps the
 * local Home Assistant and ELISE in step — registry, meaningful state changes, heartbeats — and
 * executes ELISE's commands after validating each one again here: known schema, not expired,
 * a device this hub reported, never twice. It only ever calls Home Assistant's own actions.
 */
export class HubAgent {
  private ha: HomeAssistantClient;
  private cloud: EliseCloud;
  private devices = new Map<string, SyncedDevice>();
  private byEntity = new Map<string, string>();
  private executed = new Set<string>();
  private pendingStates = new Map<string, HaState>();
  /** Latest state of each device's primary entity: local reads never need the cloud. */
  private latest = new Map<string, HaState>();
  private stopped = false;
  private connected = false;

  constructor(
    private readonly config: HubConfig & { hubToken: string },
    haToken: string,
  ) {
    this.ha = new HomeAssistantClient(config.haUrl, haToken);
    this.cloud = new EliseCloud(config.eliseUrl, config.hubToken);
  }

  async start() {
    // ELISE Cloud may be down: the home keeps working locally (ADR-081).
    await this.beat("initializing").catch((e) =>
      log("home_heartbeat_failed", { message: (e as Error).message }),
    );
    void this.heartbeats();
    void this.commandLoop();
    for (;;) {
      if (this.stopped) return;
      try {
        await this.connectProvider();
        await new Promise<void>((resolve) => (this.ha.onClose = resolve));
        log("home_provider_disconnected");
      } catch (e) {
        log("home_provider_error", { message: (e as Error).message });
      }
      this.connected = false;
      await this.beat("error").catch(() => undefined);
      await new Promise((r) => setTimeout(r, 10_000)); // reconnect
    }
  }

  stop() {
    this.stopped = true;
    this.ha.close();
  }

  private async connectProvider() {
    await this.ha.connect();
    this.connected = true;
    await this.sync();
    await this.ha.subscribeStates((s) => this.onState(s));
    await this.beat("ready");
    log("home_provider_connected", { version: this.ha.version, devices: this.devices.size });
  }

  /** The registry, normalized here: only ELISE shapes leave this machine. */
  async sync() {
    const started = Date.now();
    const [states, entries] = await Promise.all([this.ha.states(), this.ha.entityRegistry()]);
    const deviceIds = [
      ...new Set(entries.map((e) => e.device_id).filter((d): d is string => Boolean(d))),
    ];
    const names = await this.ha.names(deviceIds).catch(() => ({ devices: [], areas: [] }));
    const registry = normalizeRegistry(states, entries, names);
    this.devices = new Map(registry.devices.map((d) => [d.providerKey, d]));
    this.byEntity = new Map(
      registry.devices.flatMap((d) => d.entityIds.map((e) => [e, d.providerKey] as const)),
    );
    this.latest = new Map(
      states.filter((s) => this.byEntity.has(s.entity_id)).map((s) => [s.entity_id, s] as const),
    );
    // The registry is usable locally right away; ELISE Cloud catches up when reachable.
    try {
      const r = await this.cloud.sync(registry);
      log("home_sync", { devices: r.devices, rooms: r.rooms, latency_ms: Date.now() - started });
    } catch (e) {
      log("home_sync_deferred", { message: (e as Error).message });
    }
  }

  // ── Adding devices (ADR-090), local only: the engine's token never leaves this computer ──

  async discoveries(): Promise<DiscoveredDevice[]> {
    if (!this.connected) return [];
    return discoveredDevices(await this.ha.flowProgress());
  }

  async openDiscovery(flowId: string): Promise<DiscoveryStep> {
    if (!isFlowId(flowId)) return { kind: "aborted", reason: "not_found" };
    return discoveryStep(await this.ha.flowStep(flowId), flowId);
  }

  async answerDiscovery(flowId: string, answers: Record<string, unknown>): Promise<DiscoveryStep> {
    if (!isFlowId(flowId)) return { kind: "aborted", reason: "not_found" };
    const current = discoveryStep(await this.ha.flowStep(flowId), flowId);
    const fields = current.kind === "form" ? current.fields : [];
    const step = discoveryStep(
      await this.ha.flowSubmit(flowId, stepAnswers(fields, answers)),
      flowId,
    );
    if (step.kind === "added") {
      log("home_device_added");
      // Its devices show up in the registry within seconds; ELISE picks them up twice to be sure.
      for (const ms of [4000, 20_000])
        setTimeout(() => void this.sync().catch(() => undefined), ms);
    }
    return step;
  }

  async ignoreDiscovery(flowId: string, name: string) {
    if (!isFlowId(flowId)) return;
    await this.ha.ignoreFlow(flowId, name.slice(0, 80));
  }

  /** Meaningful changes only: a device's primary entity, batched for a moment. */
  private onState(s: HaState) {
    const key = this.byEntity.get(s.entity_id);
    const device = key ? this.devices.get(key) : undefined;
    if (!device || device.entityIds[0] !== s.entity_id) return;
    this.latest.set(s.entity_id, s);
    const first = this.pendingStates.size === 0;
    this.pendingStates.set(key!, s);
    if (first) setTimeout(() => void this.flushStates(), 1500);
  }

  private async flushStates() {
    const batch = [...this.pendingStates.entries()];
    this.pendingStates.clear();
    await this.cloud
      .states(
        batch.map(([providerKey, s]) => ({
          providerKey,
          state: stateOf(s),
          available: s.state !== "unavailable",
          stateUpdatedAt: s.last_updated ?? null,
        })),
      )
      .catch((e) => log("home_state_push_failed", { message: (e as Error).message }));
  }

  private async beat(runtimeState: "initializing" | "ready" | "error") {
    await this.cloud.heartbeat({
      providerConnected: this.connected,
      runtimeState,
      providerVersion: this.ha.version,
      agentVersion: AGENT_VERSION,
      protocolVersion: HOME_PROTOCOL_VERSION,
    });
  }

  private async heartbeats() {
    let lastSync = Date.now();
    while (!this.stopped) {
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS));
      await this.beat(this.connected ? "ready" : "error").catch((e) =>
        log("home_heartbeat_failed", { message: (e as Error).message }),
      );
      if (this.connected && Date.now() - lastSync > RESYNC_MS) {
        lastSync = Date.now();
        await this.sync().catch((e) => log("home_sync_failed", { message: (e as Error).message }));
      }
    }
  }

  private async commandLoop() {
    while (!this.stopped) {
      try {
        const { commands } = await this.cloud.commands(25);
        // Same device: in order. Different devices: in parallel.
        const byDevice = new Map<string, HubCommand[]>();
        for (const c of commands)
          byDevice.set(c.deviceId, [...(byDevice.get(c.deviceId) ?? []), c]);
        await Promise.all(
          [...byDevice.values()].map(async (list) => {
            for (const c of list) await this.execute(c);
          }),
        );
      } catch (e) {
        log("home_commands_poll_failed", { message: (e as Error).message });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /** What this hub sees right now (ADR-081): for the local runtime, no secrets. */
  status() {
    return { providerConnected: this.connected, devices: this.devices.size };
  }

  localDevices() {
    return [...this.devices.values()].map((d) => {
      const s = this.latest.get(d.entityIds[0]!);
      return {
        providerKey: d.providerKey,
        name: d.name,
        type: d.type,
        capabilities: d.capabilities,
        state: s ? stateOf(s) : d.state,
        available: s ? s.state !== "unavailable" : d.available,
      };
    });
  }

  /**
   * A local control with ELISE Cloud unreachable: the same canonical validation as every other
   * path, against the home's own source of truth. Never a raw provider call.
   */
  async executeLocal(
    providerKey: string,
    inputs: HomeActionInput[],
  ): Promise<{ ok: true; state: HomeState | null } | { ok: false; error: string }> {
    const device = this.devices.get(providerKey);
    if (!device) return { ok: false, error: "UNKNOWN_TARGET" };
    if (!this.connected) return { ok: false, error: "PROVIDER_OFFLINE" };
    const s = this.latest.get(device.entityIds[0]!);
    const current = { ...device, state: s ? stateOf(s) : device.state };
    const actions: HomeAction[] = [];
    for (const input of inputs) {
      const v = validateAction(current, input);
      if (!v.ok) return { ok: false, error: v.message };
      actions.push(v.action);
    }
    const started = Date.now();
    try {
      for (const call of toServiceCalls(device.entityIds[0]!, actions))
        await this.ha.callService(call);
      const fresh = (await this.ha.states()).find((x) => x.entity_id === device.entityIds[0]);
      if (fresh) this.latest.set(fresh.entity_id, fresh);
      log("home_local_command", { status: "succeeded", latency_ms: Date.now() - started });
      return { ok: true, state: fresh ? stateOf(fresh) : null };
    } catch (e) {
      log("home_local_command", { status: "failed", latency_ms: Date.now() - started });
      return { ok: false, error: String((e as Error).message).slice(0, 60) };
    }
  }

  /** Defense in depth: nothing runs just because it arrived. */
  async execute(raw: unknown) {
    const parsed = hubCommandSchema.safeParse(raw);
    if (!parsed.success) return log("home_command_rejected", { reason: "schema" });
    const c = parsed.data;
    if (this.executed.has(c.id)) return log("home_command_duplicate", { command_id: c.id });
    this.executed.add(c.id);
    if (this.executed.size > 2000) this.executed = new Set([...this.executed].slice(-1000));
    if (Date.parse(c.expiresAt) <= Date.now()) {
      return this.report(c.id, { status: "failed", error: "EXPIRED" });
    }
    const device = this.devices.get(c.target.providerKey);
    if (!device || device.entityIds[0] !== c.target.entityIds[0])
      return this.report(c.id, { status: "failed", error: "UNKNOWN_TARGET" });
    if (!this.connected) return this.report(c.id, { status: "failed", error: "PROVIDER_OFFLINE" });
    const started = Date.now();
    await this.report(c.id, { status: "executing" });
    try {
      for (const call of toServiceCalls(device.entityIds[0]!, c.actions))
        await this.ha.callService(call);
      const fresh = (await this.ha.states()).find((s) => s.entity_id === device.entityIds[0]);
      await this.report(c.id, {
        status: "succeeded",
        latencyMs: Date.now() - started,
        ...(fresh ? { state: stateOf(fresh) } : {}),
      });
    } catch (e) {
      await this.report(c.id, {
        status: "failed",
        error: String((e as Error).message).slice(0, 60),
        latencyMs: Date.now() - started,
      });
    }
  }

  private async report(
    id: string,
    r: {
      status: "executing" | "succeeded" | "failed";
      error?: string;
      state?: HomeState;
      latencyMs?: number;
    },
  ) {
    await this.cloud
      .result(id, r)
      .catch((e) => log("home_result_failed", { command_id: id, message: (e as Error).message }));
    if (r.status !== "executing")
      log("home_command", {
        command_id: id,
        status: r.status,
        error: r.error ?? null,
        latency_ms: r.latencyMs ?? null,
      });
  }
}
