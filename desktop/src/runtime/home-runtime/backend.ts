import type { HomeRuntimeRequirement, HomeRuntimeProgress } from "@/core/home/runtime";

import type { HomeRuntimeRelease } from "./releases";

/** A step failed in a way the person can act on (mapped to ES/EN copy by code). */
export class RuntimeError extends Error {
  constructor(
    readonly code:
      | "HOME_RUNTIME_REQUIREMENT_MISSING"
      | "HOME_RUNTIME_UNSUPPORTED_HOST"
      | "HOME_RUNTIME_DISK_LOW"
      | "HOME_RUNTIME_ELEVATION_DECLINED"
      | "HOME_RUNTIME_DOWNLOAD_FAILED"
      | "HOME_RUNTIME_VERIFY_FAILED"
      | "HOME_RUNTIME_INSTALL_FAILED"
      | "HOME_RUNTIME_START_FAILED"
      | "HOME_RUNTIME_NETWORK_FAILED"
      | "HOME_RUNTIME_BOOTSTRAP_FAILED",
    message: string,
  ) {
    super(message);
  }
}

/** Credentials ELISE created for itself on its own engine (stored OS-encrypted by Desktop). */
export interface EngineCredentials {
  haUrl: string;
  haToken: string;
  /** The engine's owner password: only for "Abrir motor local" (advanced). */
  ownerPassword: string | null;
}

/**
 * How one kind of host provisions and runs the Home engine (ADR-082). The manager owns phases,
 * persistence, retries and recovery; a backend only knows its own platform's steps. Every step
 * is idempotent so an interrupted setup can simply run again.
 */
export interface HomeRuntimeBackend {
  readonly kind: "wsl_container" | "external" | "unsupported";
  checkRequirements(): Promise<HomeRuntimeRequirement[]>;
  /** Turn on what ELISE can turn on (asks for admin at this exact step). */
  enableRequirements(): Promise<{ restartRequired: boolean }>;
  /** Resumable; returns the verified artifact's local path. */
  download(
    release: HomeRuntimeRelease,
    onProgress: (p: HomeRuntimeProgress) => void,
  ): Promise<string>;
  install(
    release: HomeRuntimeRelease,
    artifact: string,
    onProgress: (p: HomeRuntimeProgress) => void,
  ): Promise<void>;
  isInstalled(): Promise<boolean>;
  /** Starts the engine and resolves once it answers locally. */
  start(): Promise<void>;
  stop(): Promise<void>;
  healthy(): Promise<boolean>;
  /** First run only: ELISE becomes the engine's owner and gets a token for itself. */
  bootstrap(language: string): Promise<EngineCredentials>;
  /** Copy of the engine's data before an update. Returns the backup path. */
  backup(): Promise<string | null>;
  restore(backup: string): Promise<void>;
  /** Removes the engine and its data (only after the person confirms). */
  reset(): Promise<void>;
}
