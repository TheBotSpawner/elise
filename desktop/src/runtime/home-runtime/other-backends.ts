import type { HomeRuntimeRequirement } from "@/core/home/runtime";

import { RuntimeError, type EngineCredentials, type HomeRuntimeBackend } from "./backend";

/**
 * Development only (ADR-082): a Home Assistant already running on this machine or network
 * (ELISE_HA_URL + HA_TOKEN). Nothing to provision; it must answer to count as ready.
 */
export class ExternalBackend implements HomeRuntimeBackend {
  readonly kind = "external" as const;
  constructor(private readonly creds: EngineCredentials) {}
  async checkRequirements(): Promise<HomeRuntimeRequirement[]> {
    return [];
  }
  async enableRequirements() {
    return { restartRequired: false };
  }
  async download() {
    return "";
  }
  async install() {}
  async isInstalled() {
    return true;
  }
  async start() {
    if (!(await this.healthy()))
      throw new RuntimeError("HOME_RUNTIME_START_FAILED", "the external engine doesn't answer");
  }
  async stop() {}
  async healthy() {
    try {
      const r = await fetch(`${this.creds.haUrl}/api/`, { signal: AbortSignal.timeout(5000) });
      return r.status === 401 || r.ok;
    } catch {
      return false;
    }
  }
  async bootstrap() {
    return this.creds;
  }
  async backup() {
    return null;
  }
  async restore() {}
  async reset() {}
}

/** Hosts without a managed runtime yet (macOS, Linux): said plainly, never attempted. */
export class UnsupportedBackend implements HomeRuntimeBackend {
  readonly kind = "unsupported" as const;
  async checkRequirements(): Promise<HomeRuntimeRequirement[]> {
    return [{ key: "windows_version", ok: false, fix: "person", detail: process.platform }];
  }
  private no(): never {
    throw new RuntimeError("HOME_RUNTIME_UNSUPPORTED_HOST", process.platform);
  }
  async enableRequirements(): Promise<{ restartRequired: boolean }> {
    return this.no();
  }
  async download(): Promise<string> {
    return this.no();
  }
  async install() {
    this.no();
  }
  async isInstalled() {
    return false;
  }
  async start() {
    this.no();
  }
  async stop() {}
  async healthy() {
    return false;
  }
  async bootstrap(): Promise<EngineCredentials> {
    return this.no();
  }
  async backup() {
    return null;
  }
  async restore() {}
  async reset() {}
}
