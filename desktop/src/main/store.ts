import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { SNAPSHOT_SCHEMA_VERSION } from "@/core/platform/links";
import type { CachedSnapshot, DesktopPreferences } from "@/core/platform/platform";

import { log } from "./log";

/**
 * Local Desktop state (ADR-081), versioned and migrated — never wiped on update:
 * - state.json: installation id, device preferences, window bounds (not secret);
 * - secrets.bin: session + hub credential, encrypted with the OS (safeStorage: DPAPI/Keychain);
 * - cache/<scope>/<key>.json: allowlisted last-known data, per account and workspace.
 */
const STATE_VERSION = 1;

export interface DesktopState {
  version: number;
  installationId: string;
  preferences: DesktopPreferences;
  window: { width: number; height: number; x?: number; y?: number; maximized?: boolean } | null;
}

const DEFAULTS = (): DesktopState => ({
  version: STATE_VERSION,
  installationId: randomUUID(),
  // The wake word is off until the person turns it on (ADR-095): an update never starts it.
  preferences: {
    startAtLogin: true,
    keepInBackground: true,
    notifications: true,
    wakeWord: false,
    wakeChime: true,
  },
  window: null,
});

const dir = () => app.getPath("userData");
const path = (name: string) => join(dir(), name);

function writeAtomic(file: string, data: string | Buffer) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Older shapes → current. A failed migration keeps the file aside, recoverable. */
export function migrateState(raw: unknown): DesktopState {
  const base = DEFAULTS();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<DesktopState>;
  return {
    version: STATE_VERSION,
    installationId:
      typeof r.installationId === "string" && /^[0-9a-f-]{36}$/.test(r.installationId)
        ? r.installationId
        : base.installationId,
    preferences: { ...base.preferences, ...(r.preferences ?? {}) },
    window: r.window ?? null,
  };
}

let state: DesktopState | null = null;

export function loadState(): DesktopState {
  if (state) return state;
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(path("state.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log("desktop_state_unreadable");
      try {
        renameSync(path("state.json"), path(`state.corrupt-${Date.now()}.json`));
      } catch {
        // nothing to keep
      }
    }
  }
  state = migrateState(raw);
  saveState(state);
  return state;
}

export function saveState(next: DesktopState) {
  state = next;
  writeAtomic(path("state.json"), JSON.stringify(next, null, 2));
}

export function updateState(patch: (s: DesktopState) => DesktopState) {
  saveState(patch(loadState()));
}

// ---- Secrets (OS-encrypted) ----

export interface DesktopSecrets {
  /** Supabase session cookies for ELISE Cloud (contain the refresh token). */
  cookies?: Record<string, string>;
  userId?: string;
  workspaceId?: string;
  /** The home hub credential when this computer hosts ELISE Home (ADR-080). */
  hubToken?: string;
  /** Whose home that is: local control only for a person signed in to that workspace. */
  hubWorkspaceId?: string;
  /** Credentials ELISE created on its own managed engine (ADR-082). */
  engine?: { haUrl: string; haToken: string; ownerPassword: string | null };
}

export function readSecrets(): DesktopSecrets {
  try {
    const buf = readFileSync(path("secrets.bin"));
    if (!safeStorage.isEncryptionAvailable()) return {};
    return JSON.parse(safeStorage.decryptString(buf)) as DesktopSecrets;
  } catch {
    return {};
  }
}

export function writeSecrets(s: DesktopSecrets) {
  // Never fall back to plaintext: without OS encryption, the session lives in memory only.
  if (!safeStorage.isEncryptionAvailable()) {
    log("desktop_secrets_unencrypted_unavailable");
    return;
  }
  writeAtomic(path("secrets.bin"), safeStorage.encryptString(JSON.stringify(s)));
}

// ---- Snapshot cache ----

const scopeDir = (scope: string) => path(join("cache", scope.replace(/[^\w.-]/g, "_")));
const keyFile = (scope: string, key: string) =>
  join(scopeDir(scope), `${key.replace(/[^\w.-]/g, "_")}.json`);

export function cacheGet(scope: string, key: string): CachedSnapshot | null {
  try {
    const c = JSON.parse(readFileSync(keyFile(scope, key), "utf8")) as CachedSnapshot;
    if (c.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || c.scope !== scope) return null;
    return c;
  } catch {
    return null; // missing or corrupt: never blocks startup
  }
}

export function cacheSet(
  scope: string,
  key: string,
  value: unknown,
  sourceUpdatedAt: string | null,
) {
  const c: CachedSnapshot = {
    value,
    cachedAt: new Date().toISOString(),
    sourceUpdatedAt,
    scope,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  };
  writeAtomic(keyFile(scope, key), JSON.stringify(c));
}

export function clearCache() {
  rmSync(path("cache"), { recursive: true, force: true });
}
