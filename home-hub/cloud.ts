import type { HomeState, HubCommand } from "../src/core/home/model";
import type { SyncedRegistry } from "../src/infrastructure/home/home-assistant";

/**
 * The hub's only channel to ELISE (ADR-079): outbound HTTPS with its own bearer token. Nothing
 * at home listens for connections.
 */
export class EliseCloud {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
  ) {}

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    const r = await fetch(new URL(`/api/home/hub/${path}`, this.baseUrl), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await r.json().catch(() => ({}))) as T & {
      error?: { code: string; message: string };
    };
    if (!r.ok)
      throw Object.assign(new Error(json.error?.message ?? `ELISE ${r.status}`), {
        status: r.status,
        code: json.error?.code,
      });
    return json;
  }

  pair = (code: string, meta: { name?: string; agentVersion: string; protocolVersion: number }) =>
    this.call<{ hubId: string; homeId: string; token: string; protocolVersion: number }>(
      "POST",
      "pair",
      {
        code,
        ...meta,
        hostKind: "service",
      },
    );

  heartbeat = (h: {
    providerConnected: boolean;
    runtimeState: "initializing" | "ready" | "error";
    providerVersion: string | null;
    agentVersion: string;
    protocolVersion: number;
  }) => this.call<{ ok: true; protocolVersion: number }>("POST", "heartbeat", h);

  sync = (registry: SyncedRegistry) =>
    this.call<{ devices: number; rooms: number }>("POST", "sync", registry, 30_000);

  states = (
    devices: {
      providerKey: string;
      state: HomeState;
      available: boolean;
      stateUpdatedAt: string | null;
    }[],
  ) => this.call<{ ok: true }>("POST", "states", { devices });

  commands = (waitSeconds: number) =>
    this.call<{ commands: HubCommand[] }>(
      "GET",
      `commands?wait=${waitSeconds}`,
      undefined,
      (waitSeconds + 15) * 1000,
    );

  result = (
    id: string,
    r: {
      status: "executing" | "succeeded" | "failed";
      error?: string;
      state?: HomeState;
      latencyMs?: number;
    },
  ) => this.call<{ ok: true }>("POST", `commands/${id}`, r);
}
