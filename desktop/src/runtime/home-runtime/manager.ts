import { EventEmitter } from "node:events";

import {
  requirementsMet,
  resumePhase,
  type HomeRuntimeErrorCode,
  type HomeRuntimePhase,
  type HomeRuntimeProgress,
  type HomeRuntimeRequirement,
  type HomeRuntimeStatus,
} from "@/core/home/runtime";

import { RuntimeError, type EngineCredentials, type HomeRuntimeBackend } from "./backend";
import { CURRENT_HOME_RUNTIME, type HomeRuntimeRelease } from "./releases";

/** What survives a restart (no secrets: credentials live in Desktop's encrypted store). */
export interface PersistedRuntime {
  phase: HomeRuntimePhase;
  enabled: boolean;
  version: string | null;
  error: HomeRuntimeStatus["error"];
  updatedAt: string;
}

export interface RuntimeStore {
  load(): PersistedRuntime | null;
  save(state: PersistedRuntime): void;
}

const MAX_AUTO_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;

/**
 * ELISE Home runtime manager (ADR-082): one operation at a time, every phase persisted, every
 * failure mapped to a code the person can act on, recovery after a crash or reboot, and a
 * health watch that restarts the engine a few times before saying "degraded" honestly.
 * Events: "status" (HomeRuntimeStatus), "credentials" (EngineCredentials, first run only).
 */
export class HomeRuntimeManager extends EventEmitter {
  private state: PersistedRuntime;
  private progress: HomeRuntimeProgress | null = null;
  private requirements: HomeRuntimeRequirement[] | null = null;
  private busy: Promise<void> | null = null;
  private restarts: number[] = [];
  private watch: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly backend: HomeRuntimeBackend,
    private readonly store: RuntimeStore,
    private readonly options: {
      language: string;
      /** Desktop already holds this engine's credentials (no bootstrap needed). */
      hasCredentials: () => boolean;
      release?: HomeRuntimeRelease;
      healthIntervalMs?: number;
    },
  ) {
    super();
    this.state = store.load() ?? {
      phase: "not_installed",
      enabled: false,
      version: null,
      error: null,
      updatedAt: new Date().toISOString(),
    };
  }

  private get release() {
    return this.options.release ?? CURRENT_HOME_RUNTIME;
  }

  status(): HomeRuntimeStatus {
    return {
      phase: this.state.phase,
      progress: this.progress,
      version: this.state.version,
      error: this.state.error,
      requirements: this.requirements,
      provider: this.backend.kind,
      enabled: this.state.enabled,
    };
  }

  private set(patch: Partial<PersistedRuntime>, progress: HomeRuntimeProgress | null = null) {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
    this.progress = progress;
    this.store.save(this.state);
    this.emit("status", this.status());
  }

  private fail(error: unknown, fallback: HomeRuntimeErrorCode) {
    const code = error instanceof RuntimeError ? error.code : fallback;
    const detail = error instanceof Error ? error.message.slice(0, 300) : null;
    const phase: HomeRuntimePhase =
      code === "HOME_RUNTIME_REQUIREMENT_MISSING" ||
      code === "HOME_RUNTIME_UNSUPPORTED_HOST" ||
      code === "HOME_RUNTIME_DISK_LOW"
        ? "requirements_missing"
        : "error";
    this.set({ phase, error: { code, detail } });
  }

  /** One operation at a time; a second request while busy just waits for the first. */
  private exclusive(op: () => Promise<void>): Promise<void> {
    if (this.busy) return this.busy;
    this.busy = op().finally(() => (this.busy = null));
    return this.busy;
  }

  /** On launch: pick up where things were (resume setup, or start the installed engine). */
  async init() {
    const installed = await this.backend.isInstalled().catch(() => false);
    const next = resumePhase(this.state.phase, installed);
    if (!this.state.enabled) {
      if (next !== this.state.phase) this.set({ phase: installed ? "stopped" : "not_installed" });
      return;
    }
    if (next === "downloading" || next === "checking_requirements") return this.setup();
    // Installed and on: it runs whenever ELISE runs (login, after a quit, after an error).
    if (installed && ["starting", "stopped", "error"].includes(next)) return this.start();
  }

  /** "Configurar ELISE Home" and "Reintentar": requirements → download → install → start. */
  setup(): Promise<void> {
    return this.exclusive(async () => {
      this.set(
        { enabled: true, error: null, phase: "checking_requirements" },
        { stage: "checking" },
      );
      try {
        this.requirements = await this.backend.checkRequirements();
      } catch (e) {
        return this.fail(e, "HOME_RUNTIME_UNSUPPORTED_HOST");
      }
      if (!requirementsMet(this.requirements)) {
        const blocking = this.requirements.find((r) => !r.ok && r.fix === "person");
        const code: HomeRuntimeErrorCode = !blocking
          ? "HOME_RUNTIME_REQUIREMENT_MISSING"
          : blocking.key === "disk"
            ? "HOME_RUNTIME_DISK_LOW"
            : "HOME_RUNTIME_UNSUPPORTED_HOST";
        return this.set({
          phase: "requirements_missing",
          error: { code, detail: blocking?.detail ?? null },
        });
      }
      await this.provision(this.release);
    });
  }

  private async provision(release: HomeRuntimeRelease) {
    let artifact: string;
    try {
      this.set({ phase: "downloading" }, { stage: "downloading_base" });
      artifact = await this.backend.download(release, (p) =>
        this.set({ phase: p.stage === "verifying" ? "verifying" : "downloading" }, p),
      );
    } catch (e) {
      return this.fail(e, "HOME_RUNTIME_DOWNLOAD_FAILED");
    }
    try {
      this.set({ phase: "installing" }, { stage: "installing" });
      await this.backend.install(release, artifact, (p) => this.set({ phase: "installing" }, p));
      this.set({ version: release.version });
    } catch (e) {
      return this.fail(e, "HOME_RUNTIME_INSTALL_FAILED");
    }
    await this.startEngine();
  }

  private async startEngine() {
    try {
      this.set({ phase: "starting" }, { stage: "starting" });
      await this.backend.start();
    } catch (e) {
      return this.fail(e, "HOME_RUNTIME_START_FAILED");
    }
    if (!this.options.hasCredentials()) {
      try {
        this.set({ phase: "starting" }, { stage: "connecting" });
        const creds: EngineCredentials = await this.backend.bootstrap(this.options.language);
        this.emit("credentials", creds);
      } catch (e) {
        return this.fail(e, "HOME_RUNTIME_BOOTSTRAP_FAILED");
      }
    }
    this.set({ phase: "ready", error: null });
    this.watchHealth();
  }

  /** The person (or the setup screen) asked ELISE to turn on what Windows needs. */
  async enableRequirements(): Promise<void> {
    await this.exclusive(async () => {
      this.set({ phase: "checking_requirements", error: null }, { stage: "enabling" });
      try {
        const { restartRequired } = await this.backend.enableRequirements();
        if (restartRequired) this.set({ phase: "restart_required" });
      } catch (e) {
        this.fail(e, "HOME_RUNTIME_REQUIREMENT_MISSING");
      }
    });
    // Enabled without a restart: carry straight on with setup.
    if (this.state.phase === "checking_requirements") await this.setup();
  }

  start(): Promise<void> {
    return this.exclusive(async () => {
      if (!(await this.backend.isInstalled().catch(() => false)))
        return this.set({ phase: "not_installed" });
      await this.startEngine();
    });
  }

  stop(): Promise<void> {
    return this.exclusive(async () => {
      this.stopWatch();
      await this.backend.stop().catch(() => undefined);
      this.set({ phase: this.state.phase === "not_installed" ? "not_installed" : "stopped" });
    });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  /** A newer allowlisted release: back up, swap, start; roll back if the new one fails. */
  update(release: HomeRuntimeRelease = this.release): Promise<void> {
    return this.exclusive(async () => {
      if (this.state.version === release.version) return;
      this.stopWatch();
      this.set({ phase: "updating", error: null }, { stage: "backing_up" });
      let backup: string | null = null;
      try {
        backup = await this.backend.backup();
        await this.backend.stop();
        const artifact = await this.backend.download(release, (p) =>
          this.set({ phase: "updating" }, p),
        );
        await this.backend.install(release, artifact, (p) => this.set({ phase: "updating" }, p));
        this.set({ version: release.version });
      } catch (e) {
        if (backup) await this.backend.restore(backup).catch(() => undefined);
        await this.startEngine();
        if (this.state.phase === "ready")
          this.set({
            error: {
              code: e instanceof RuntimeError ? e.code : "HOME_RUNTIME_INSTALL_FAILED",
              detail: "update rolled back",
            },
          });
        return;
      }
      await this.startEngine();
    });
  }

  /** Removes the engine and its data. Only after the person confirmed it. */
  reset(): Promise<void> {
    return this.exclusive(async () => {
      this.stopWatch();
      await this.backend.stop().catch(() => undefined);
      await this.backend.reset();
      this.requirements = null;
      this.set({ phase: "not_installed", enabled: false, version: null, error: null });
    });
  }

  diagnostics() {
    return {
      status: this.status(),
      release: this.release.version,
      engine: this.release.engineVersion,
      updatedAt: this.state.updatedAt,
    };
  }

  private watchHealth() {
    this.stopWatch();
    this.watch = setInterval(async () => {
      if (this.busy || !["ready", "degraded"].includes(this.state.phase)) return;
      const ok = await this.backend.healthy().catch(() => false);
      if (ok) {
        if (this.state.phase === "degraded") this.set({ phase: "ready" });
        return;
      }
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (this.restarts.length >= MAX_AUTO_RESTARTS) return this.set({ phase: "degraded" });
      this.restarts.push(now);
      this.set({ phase: "degraded" });
      void this.exclusive(() => this.startEngine());
    }, this.options.healthIntervalMs ?? 30_000);
  }

  private stopWatch() {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }

  dispose() {
    this.stopWatch();
  }
}
