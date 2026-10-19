import { BrowserWindow, powerMonitor } from "electron";
import { EventEmitter } from "node:events";

import type { WakeControl, WakeReport } from "@/core/platform/platform";

import { log } from "./log";
import { loadState } from "./store";
import { EVENTS } from "../shared/channels";

/**
 * The wake word's control in the main process (ADR-095). The listener itself runs in the app's
 * renderer — it owns the microphone, the local recognizer and the existing voice pipeline — and
 * keeps running with the window hidden. Here: whether it should listen (the person's setting, a
 * pause from the tray, a locked screen or sleep), and what it says it's doing, for the tray.
 * Never audio, never text: only states.
 */
export const wake = new EventEmitter();

let paused = false;
let suspended = false;
let status: WakeReport = "off";

export function wakeControl(): WakeControl {
  const p = loadState().preferences;
  return { enabled: p.wakeWord, paused, suspended, chime: p.wakeChime };
}

export const wakeStatus = () => status;

function publish() {
  const c = wakeControl();
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(EVENTS.wake, c);
    // A hidden window that listens must keep its timers and audio running at full rate.
    w.webContents.setBackgroundThrottling(!c.enabled);
  }
  wake.emit("change");
}

export function setWakePaused(next: boolean) {
  paused = next;
  log("desktop_wake_paused", { paused });
  publish();
  return wakeControl();
}

/** The setting changed (Settings → ELISE Desktop). */
export const wakePreferenceChanged = () => publish();

export function reportWake(next: WakeReport) {
  if (next === status) return;
  status = next;
  log("desktop_wake_status", { status });
  wake.emit("change");
}

/** Locked screen or sleep: the microphone is released; it comes back on unlock / resume. */
export function watchSystem() {
  const set = (value: boolean, why: string) => {
    if (suspended === value) return;
    suspended = value;
    log("desktop_wake_suspended", { suspended, why });
    publish();
  };
  powerMonitor.on("lock-screen", () => set(true, "lock"));
  powerMonitor.on("unlock-screen", () => set(false, "unlock"));
  powerMonitor.on("suspend", () => set(true, "suspend"));
  powerMonitor.on("resume", () => set(false, "resume"));
}

/** A window that just loaded learns the current control (and its throttling follows it). */
export function applyWakeTo(win: BrowserWindow) {
  win.webContents.setBackgroundThrottling(!wakeControl().enabled);
}
