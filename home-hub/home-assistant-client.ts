import type {
  HaEntityEntry,
  HaNames,
  HaServiceCall,
  HaState,
} from "../src/infrastructure/home/home-assistant";
import { namesTemplate } from "../src/infrastructure/home/home-assistant";

/**
 * A minimal client for Home Assistant's documented APIs: the WebSocket API (auth, get_states,
 * config/entity_registry/list, subscribe_events state_changed, call_service) and the REST
 * template endpoint for device and area names. Uses Node's built-in WebSocket and fetch.
 */
export class HomeAssistantClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<(s: HaState) => void>();
  version: string | null = null;
  onClose: (() => void) | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** REST: is Home Assistant reachable and is the token accepted? */
  async ping(): Promise<{ ok: boolean; status: number }> {
    const r = await fetch(new URL("/api/", this.baseUrl), {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(5000),
    });
    return { ok: r.ok, status: r.status };
  }

  async connect(): Promise<void> {
    const url = new URL("/api/websocket", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Home Assistant didn't answer")), 10_000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as {
          type: string;
          ha_version?: string;
          message?: string;
        };
        if (msg.type === "auth_required")
          ws.send(JSON.stringify({ type: "auth", access_token: this.token }));
        else if (msg.type === "auth_ok") {
          clearTimeout(timer);
          this.version = msg.ha_version ?? null;
          ws.onmessage = (e) => this.receive(String(e.data));
          resolve();
        } else if (msg.type === "auth_invalid") {
          clearTimeout(timer);
          reject(new Error("Home Assistant rejected the token"));
        }
      };
      ws.onerror = () => reject(new Error("Can't reach Home Assistant"));
    });
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error("Connection closed"));
      this.pending.clear();
      this.onClose?.();
    };
  }

  close() {
    this.ws?.close();
  }

  private receive(raw: string) {
    const msg = JSON.parse(raw) as {
      id: number;
      type: string;
      success?: boolean;
      result?: unknown;
      error?: { code: string; message: string };
      event?: { event_type: string; data: { new_state: HaState | null } };
    };
    if (
      msg.type === "event" &&
      msg.event?.event_type === "state_changed" &&
      msg.event.data.new_state
    ) {
      for (const l of this.listeners) l(msg.event.data.new_state);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p || msg.type !== "result") return;
    this.pending.delete(msg.id);
    if (msg.success) p.resolve(msg.result);
    else p.reject(new Error(msg.error?.code ?? "home_assistant_error"));
  }

  private command<T>(payload: Record<string, unknown>): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Not connected"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      ws.send(JSON.stringify({ id, ...payload }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error("timeout"));
      }, 15_000);
    });
  }

  states = () => this.command<HaState[]>({ type: "get_states" });
  entityRegistry = () => this.command<HaEntityEntry[]>({ type: "config/entity_registry/list" });

  async subscribeStates(listener: (s: HaState) => void) {
    this.listeners.add(listener);
    await this.command({ type: "subscribe_events", event_type: "state_changed" });
  }

  callService = (c: HaServiceCall) =>
    this.command({
      type: "call_service",
      domain: c.domain,
      service: c.service,
      service_data: c.service_data,
      target: c.target,
    });

  /** Device and area names through the documented template API (REST). */
  async names(deviceIds: string[]): Promise<HaNames> {
    const r = await fetch(new URL("/api/template", this.baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ template: namesTemplate(deviceIds) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`template ${r.status}`);
    return JSON.parse(await r.text()) as HaNames;
  }
}
