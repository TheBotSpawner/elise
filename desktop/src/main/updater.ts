import { app, autoUpdater } from "electron";
import { EventEmitter } from "node:events";

import type { DesktopUpdateState } from "@/core/platform/platform";

import { log } from "./log";

/**
 * Updates (ADR-081): Electron's built-in updater (Squirrel on Windows, ShipIt on macOS) against
 * the release feed set at build time, per channel. Download in the background, install when
 * the person restarts — never mid-session. Builds without a feed (development, unsigned) report
 * "unsupported" instead of pretending.
 */
export const updates = new EventEmitter();
let state: DesktopUpdateState = { status: "idle" };

let required = false;
const set = (next: DesktopUpdateState) => {
  state = { ...next, ...(required ? { required } : {}) };
  updates.emit("state", state);
};

/** From the cloud's heartbeat answer: this version is too old to keep using the cloud. */
export function markRequired(value: boolean) {
  if (value === required) return;
  required = value;
  log("desktop_update_required", { required });
  set(state);
}

export const updateState = () => state;

export function initUpdater() {
  const { updateFeed, channel } = __ELISE_BUILD__;
  // Windows only for now (Squirrel). macOS needs signed builds and its own feed (ADR-084).
  if (!app.isPackaged || !updateFeed || process.platform !== "win32") {
    set({ status: "unsupported" });
    return;
  }
  // One fixed release per channel holds that channel's Squirrel feed (RELEASES + .nupkg):
  // <feed>/desktop-beta/RELEASES — the same publication that updates the download manifest.
  const url = `${updateFeed.replace(/\/$/, "")}/desktop-${channel}`;
  if (!url.startsWith("https://")) {
    log("desktop_update_feed_insecure");
    set({ status: "unsupported" });
    return;
  }
  autoUpdater.setFeedURL({ url });
  autoUpdater.on("checking-for-update", () => set({ status: "checking" }));
  autoUpdater.on("update-available", () => set({ status: "downloading" }));
  autoUpdater.on("update-not-available", () => set({ status: "not_available" }));
  autoUpdater.on("update-downloaded", (_e, _notes, version) => {
    log("desktop_update_ready", { version });
    set({ status: "ready", version });
  });
  autoUpdater.on("error", (e) => {
    log("desktop_update_error", { message: e.message });
    set({ status: "error", message: "update_failed" });
  });
  setTimeout(() => checkForUpdates(), 30_000);
  // Hourly: a new version is offered the same day it is published (download is background).
  setInterval(() => checkForUpdates(), 60 * 60_000);
}

export function checkForUpdates() {
  if (state.status === "unsupported" || state.status === "downloading") return;
  try {
    autoUpdater.checkForUpdates();
  } catch (e) {
    log("desktop_update_error", { message: (e as Error).message });
  }
}

/** Called after the local runtime has stopped cleanly (pairing and config stay on disk). */
export function installUpdate() {
  if (state.status === "ready") autoUpdater.quitAndInstall();
}
