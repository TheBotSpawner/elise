import { app, ipcMain, type IpcMainInvokeEvent } from "electron";
import { execFile } from "node:child_process";
import { join } from "node:path";

import { z } from "zod";

import { isCacheableSnapshot } from "@/core/platform/links";
import {
  DESKTOP_BRIDGE_PROTOCOL_VERSION,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  localHomeCommandSchema,
  type DesktopInfo,
  type EliseConnectivity,
  type PlatformCapability,
} from "@/core/platform/platform";

import * as cloud from "./cloud";
import { resetHome } from "./home";
import { log, recentLogs } from "./log";
import { APP_ORIGIN } from "./protocol";
import type { RuntimeHost } from "./runtime-host";
import { openExternalSafely } from "./security";
import { cacheGet, cacheSet, loadState, updateState } from "./store";
import { checkForUpdates, installUpdate, updateState as currentUpdate } from "./updater";
import { INVOKE } from "../shared/channels";

export const CAPABILITIES: PlatformCapability[] = [
  "home_hub",
  "local_runtime",
  "native_notifications",
  "open_external",
  "start_at_login",
  "auto_update",
  "snapshot_cache",
];

const prefsSchema = z
  .object({
    startAtLogin: z.boolean(),
    keepInBackground: z.boolean(),
    notifications: z.boolean(),
  })
  .partial()
  .strict();

export function desktopInfo(host: RuntimeHost): DesktopInfo {
  return {
    desktopVersion: app.getVersion(),
    rendererVersion: app.getVersion(), // the renderer ships inside the app (same release)
    bridgeProtocolVersion: DESKTOP_BRIDGE_PROTOCOL_VERSION,
    localRuntimeVersion: host.version,
    localRuntimeProtocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    platform:
      process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    arch: process.arch,
    capabilities: CAPABILITIES,
    installationId: loadState().installationId,
  };
}

export function connectivity(host: RuntimeHost): EliseConnectivity {
  const { cloud: c, internet } = cloud.cloudState();
  const phase = host.home?.runtime.phase ?? "not_installed";
  const enabled = host.home?.runtime.enabled ?? false;
  return {
    internet,
    cloud: c,
    localRuntime: host.running ? (phase === "error" ? "degraded" : "online") : "offline",
    home: !enabled
      ? "not_configured"
      : phase === "ready" && host.home?.providerConnected
        ? "online"
        : phase === "error" || phase === "stopped"
          ? "offline"
          : "degraded",
  };
}

/**
 * Every bridge call lands here: only ELISE's own page may call (sender origin), every argument
 * is validated, and nothing but these typed operations exists — no generic executor.
 */
export function registerIpc(host: RuntimeHost, applyLoginItem: () => void) {
  const handle = <A extends unknown[]>(channel: string, fn: (...args: A) => unknown) =>
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.senderFrame?.origin !== APP_ORIGIN) {
        log("desktop_ipc_rejected", { channel });
        throw new Error("Not allowed");
      }
      return fn(...(args as A));
    });

  handle(INVOKE.desktopInfo, () => desktopInfo(host));
  handle(INVOKE.connectivity, () => connectivity(host));
  handle(INVOKE.openExternal, (url: unknown) =>
    openExternalSafely(z.string().max(4096).parse(url)),
  );
  handle(INVOKE.session, () => cloud.session());
  handle(INVOKE.signIn, () => cloud.signIn());
  handle(INVOKE.signOut, async () => {
    await cloud.signOutLocal("user");
  });
  handle(INVOKE.accessToken, () => cloud.accessToken());
  handle(INVOKE.updateState, () => currentUpdate());
  handle(INVOKE.checkUpdates, () => checkForUpdates());
  handle(INVOKE.installUpdate, async () => {
    // Stop the home cleanly first; its pairing and config stay on disk for after the update.
    await host.stop();
    installUpdate();
  });
  handle(INVOKE.getPreferences, () => loadState().preferences);
  handle(INVOKE.setPreferences, (patch: unknown) => {
    const p = prefsSchema.parse(patch);
    updateState((s) => ({ ...s, preferences: { ...s.preferences, ...p } }));
    if (p.startAtLogin !== undefined) applyLoginItem();
    return loadState().preferences;
  });
  handle(INVOKE.homeState, () => host.home);
  // Long operations return at once; progress arrives as onHomeHub events.
  handle(INVOKE.homeSetup, () => host.call("setup"));
  handle(INVOKE.homeEnable, () => host.call("enableRequirements"));
  handle(INVOKE.homeReset, () => resetHome(host));
  handle(INVOKE.homeDiagnostics, async () =>
    JSON.stringify(await host.call("diagnostics").catch(() => null), null, 2),
  );
  handle(INVOKE.restartComputer, () => {
    // Only ever reached from the person's explicit "Reiniciar ahora" (setup resumes after).
    if (host.home?.runtime.phase !== "restart_required") return;
    log("desktop_restart_requested");
    execFile(join(process.env.SystemRoot ?? "C:\Windows", "System32", "shutdown.exe"), [
      "/r",
      "/t",
      "10",
    ]);
  });
  handle(INVOKE.homeDevices, async () =>
    cloud.mayControlLocalHome() ? host.call("listDevices") : [],
  );
  handle(INVOKE.homeExecute, async (command: unknown) => {
    const c = localHomeCommandSchema.parse(command);
    if (!cloud.mayControlLocalHome()) return { ok: false, error: "NOT_ALLOWED" };
    return host.call("execute", c);
  });
  handle(INVOKE.cacheGet, (key: unknown) => {
    const k = z.string().max(80).parse(key);
    const scope = cloud.sessionScope();
    return scope && isCacheableSnapshot(k) ? cacheGet(scope, k) : null;
  });
  handle(INVOKE.cacheSet, (key: unknown, value: unknown, sourceUpdatedAt: unknown) => {
    const k = z.string().max(80).parse(key);
    const scope = cloud.sessionScope();
    if (!scope || !isCacheableSnapshot(k)) return;
    if (JSON.stringify(value ?? null).length > 2_000_000) return; // last-known data, not files
    cacheSet(
      scope,
      k,
      value,
      z
        .string()
        .max(40)
        .nullable()
        .parse(sourceUpdatedAt ?? null),
    );
  });
  handle(INVOKE.diagnostics, () =>
    JSON.stringify(
      {
        ...desktopInfo(host),
        os: `${process.platform} ${process.getSystemVersion()}`,
        connectivity: connectivity(host),
        home: host.home,
        update: currentUpdate(),
        recent: recentLogs().slice(-50),
      },
      null,
      2,
    ),
  );
}
