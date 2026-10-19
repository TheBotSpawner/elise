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
  VOICE_ORB_STATES,
} from "@/core/platform/platform";

import * as cloud from "./cloud";
import { resetHome } from "./home";
import { log, recentLogs } from "./log";
import { APP_ORIGIN } from "./protocol";
import type { RuntimeHost } from "./runtime-host";
import { openExternalSafely } from "./security";
import { cacheGet, cacheSet, loadState, updateState } from "./store";
import { checkForUpdates, installUpdate, updateState as currentUpdate } from "./updater";
import { reportWake, setWakePaused, wakeControl, wakePreferenceChanged } from "./wake";
import { setWakeOrbState } from "./wake-orb";
import { INVOKE } from "../shared/channels";

export const CAPABILITIES: PlatformCapability[] = [
  "home_hub",
  "local_runtime",
  "native_notifications",
  "open_external",
  "start_at_login",
  "auto_update",
  "snapshot_cache",
  "wake_word",
];

const wakeReportSchema = z.enum([
  "off",
  "starting",
  "listening",
  "paused",
  "in_conversation",
  "no_microphone",
  "mic_denied",
  "model_failed",
]);

const prefsSchema = z
  .object({
    startAtLogin: z.boolean(),
    keepInBackground: z.boolean(),
    notifications: z.boolean(),
    wakeWord: z.boolean(),
    wakeChime: z.boolean(),
    wakeOrb: z.boolean(),
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
    cloudOrigin: __ELISE_BUILD__.cloudUrl,
    channel: __ELISE_BUILD__.channel === "beta" ? "beta" : "stable",
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
export function registerIpc(
  host: RuntimeHost,
  applyLoginItem: () => void,
  showApp: (path?: string) => void,
) {
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
    if (p.wakeWord !== undefined || p.wakeChime !== undefined || p.wakeOrb !== undefined)
      wakePreferenceChanged();
    if (p.wakeWord !== undefined) log("desktop_wake_preference", { on: p.wakeWord });
    return loadState().preferences;
  });
  // ADR-095: the wake word's control and reports — states only, never audio.
  handle(INVOKE.wakeControl, () => wakeControl());
  handle(INVOKE.wakePause, (paused: unknown) => setWakePaused(z.boolean().parse(paused)));
  handle(INVOKE.wakeReport, (status: unknown) => reportWake(wakeReportSchema.parse(status)));
  handle(INVOKE.voiceOrb, (state: unknown) =>
    setWakeOrbState(z.enum(VOICE_ORB_STATES).parse(state)),
  );
  // The person asked to see ELISE ("abrí ELISE"): the only voice path that shows the window.
  handle(INVOKE.showApp, (path: unknown) =>
    showApp(
      z
        .string()
        .regex(/^\/[A-Za-z0-9/_?=&.-]{0,200}$/)
        .nullable()
        .parse(path ?? null) ?? undefined,
    ),
  );
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
    execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "shutdown.exe"), [
      "/r",
      "/t",
      "10",
    ]);
  });
  handle(INVOKE.homeDevices, async () =>
    cloud.mayControlLocalHome() ? host.call("listDevices") : [],
  );
  // ADR-090: adding devices the engine found. Signed-in owner of this home only; every call is
  // a named action with validated input (never a URL or a raw request).
  const flow = z.object({ flowId: z.string().regex(/^[0-9A-Za-z_-]{10,64}$/) });
  handle(INVOKE.homeDiscoveries, async () =>
    cloud.mayControlLocalHome() ? host.call("homeDiscoveries", undefined, 20_000) : [],
  );
  handle(INVOKE.homeDiscoveryOpen, async (params: unknown) => {
    if (!cloud.mayControlLocalHome()) return { kind: "aborted", reason: "not_allowed" };
    return host.call("homeDiscoveryOpen", flow.parse(params), 40_000);
  });
  handle(INVOKE.homeDiscoveryAnswer, async (params: unknown) => {
    if (!cloud.mayControlLocalHome()) return { kind: "aborted", reason: "not_allowed" };
    const p = flow
      .extend({
        answers: z.record(
          z.string().max(64),
          z.union([z.string().max(500), z.number(), z.boolean()]),
        ),
      })
      .parse(params);
    return host.call("homeDiscoveryAnswer", p, 70_000);
  });
  handle(INVOKE.homeDiscoveryIgnore, async (params: unknown) => {
    if (!cloud.mayControlLocalHome()) return false;
    return host.call(
      "homeDiscoveryIgnore",
      flow.extend({ name: z.string().max(80) }).parse(params),
      20_000,
    );
  });
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
