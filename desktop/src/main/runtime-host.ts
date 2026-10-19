import { utilityProcess, type UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import type { HomeHubLocalState } from "@/core/platform/platform";

import { log } from "./log";

/**
 * Supervises the ELISE Local Runtime process (ADR-081): starts it, restarts it after a crash
 * with backoff, and gives up (state "error") after repeated failures instead of looping
 * forever. Explicit quit stops it cleanly; closing the window does not.
 */
const MAX_RESTARTS = 5;
const WINDOW_MS = 10 * 60_000;

export class RuntimeHost extends EventEmitter {
  private child: UtilityProcess | null = null;
  private nextId = 1;
  private waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private restarts: number[] = [];
  private stopping = false;
  private lastConfig: unknown = null;
  version: string | null = null;
  /** Null until the runtime reports (it's configured right after start). */
  home: HomeHubLocalState | null = null;

  start() {
    this.stopping = false;
    const child = utilityProcess.fork(join(__dirname, "runtime.cjs"), [], {
      serviceName: "ELISE Local Runtime",
      stdio: "pipe",
    });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => {
      for (const line of d.toString().split("\n").filter(Boolean)) log("runtime", { line });
    });
    child.on(
      "message",
      (m: {
        id?: number;
        ok?: boolean;
        result?: unknown;
        error?: string;
        event?: string;
        state?: HomeHubLocalState;
        creds?: unknown;
      }) => {
        if (m.event === "home" && m.state) {
          this.home = m.state;
          this.emit("home", m.state);
          return;
        }
        if (m.event === "hub_rejected") {
          this.emit("hubRejected");
          return;
        }
        if (m.event === "credentials" && m.creds) {
          this.emit("credentials", m.creds);
          return;
        }
        const w = m.id ? this.waiting.get(m.id) : undefined;
        if (!w) return;
        this.waiting.delete(m.id!);
        if (m.ok) w.resolve(m.result);
        else w.reject(new Error(m.error ?? "runtime error"));
      },
    );
    child.on("exit", (code) => {
      this.child = null;
      for (const w of this.waiting.values()) w.reject(new Error("runtime stopped"));
      this.waiting.clear();
      if (this.stopping) return;
      log("runtime_exited", { code });
      const now = Date.now();
      this.restarts = [...this.restarts.filter((t) => now - t < WINDOW_MS), now];
      if (this.restarts.length > MAX_RESTARTS) {
        if (this.home) {
          this.home = {
            ...this.home,
            runtime: {
              ...this.home.runtime,
              phase: "error",
              progress: null,
              error: { code: "HOME_RUNTIME_START_FAILED", detail: "local runtime keeps stopping" },
            },
          };
          this.emit("home", this.home);
        }
        return;
      }
      const delay = 1000 * 2 ** (this.restarts.length - 1);
      setTimeout(() => {
        this.start();
        if (this.lastConfig) void this.call("configure", this.lastConfig).catch(() => undefined);
      }, delay);
    });
    void this.call<{ version: string }>("hello")
      .then((h) => (this.version = h.version))
      .catch(() => undefined);
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("runtime not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("runtime timeout"));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v as T)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      child.postMessage({ id, method, params });
    });
  }

  configure(config: unknown) {
    this.lastConfig = config;
    return this.call("configure", config);
  }

  async stop() {
    this.stopping = true;
    if (!this.child) return;
    // The engine gets time to stop cleanly (its data stays consistent for the next start).
    await this.call("shutdown", undefined, 45_000).catch(() => undefined);
    this.child?.kill();
    this.child = null;
  }

  get running() {
    return this.child !== null;
  }
}
