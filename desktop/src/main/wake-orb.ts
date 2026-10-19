import { BrowserWindow, screen } from "electron";
import { EventEmitter } from "node:events";

import type { VoiceOrbState, WakeReport } from "@/core/platform/platform";

import { APP_ORIGIN } from "./protocol";

/**
 * A voice conversation in the background (ADR-095): ELISE's Orb in the bottom-right corner while
 * she listens to the person or answers — never while she only waits for "ELISE", never while
 * ELISE's own window is the one in use. It never takes focus (the active app keeps it); a tap on
 * it ends the conversation. Its page draws ELISE's Orb and nothing else: no preload, no bridge —
 * a tap reaches here as an in-page navigation to "#end".
 */
export const wakeOrb = new EventEmitter();

/** Sized by the screen: 7.5 % of its height (80–140 px), so it reads at any resolution. */
const sizeFor = (height: number) => Math.round(Math.min(140, Math.max(80, height * 0.075)));
let orb: BrowserWindow | null = null;
/** The page has loaded: it can show at once (no wait when a conversation starts). */
let ready: Promise<void> | null = null;
let shown = false;
let state: VoiceOrbState = "listening";

/** ELISE's own Orb renderer (renderer/orb.html). */
const PAGE = `${APP_ORIGIN}/orb.html`;

function create() {
  const { workArea } = screen.getPrimaryDisplay();
  const SIZE = sizeFor(workArea.height);
  // Away from the right edge, and above an auto-hidden taskbar too (the work area then reaches
  // the screen's edge).
  const MARGIN = Math.round(SIZE * 0.3);
  const BOTTOM = Math.round(SIZE * 0.45);
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    x: workArea.x + workArea.width - SIZE - MARGIN,
    y: workArea.y + workArea.height - SIZE - BOTTOM,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    // Clickable, never activated: a tap doesn't take focus from the app in front.
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, "floating");
  // Its page goes nowhere else; "#end" is the only thing it says.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("did-navigate-in-page", (_e, url) => {
    if (!new URL(url).hash.startsWith("#end")) return;
    shown = false;
    wakeOrb.emit("end");
    // After its shrink-away (orb.html), unless a new conversation already brought it back.
    setTimeout(() => !shown && !win.isDestroyed() && win.hide(), 250);
  });
  win.on("closed", () => {
    orb = null;
    ready = null;
    shown = false;
  });
  orb = win;
  ready = win.loadURL(PAGE).catch(() => undefined);
  return win;
}

/**
 * `appInUse`: ELISE's own window is in front (the orb would only repeat it). While "ELISE" is on,
 * the orb's window is kept loaded and hidden, so it appears the moment a conversation starts.
 */
export function updateWakeOrb(status: WakeReport, enabled: boolean, appInUse: boolean) {
  if (enabled && !orb) create();
  const want = enabled && !appInUse && status === "in_conversation";
  if (want === shown) return;
  shown = want;
  if (!want) return orb?.hide();
  // Shown without activation: the app in front keeps its focus; it pops in, so it's noticed.
  void ready?.then(() => {
    if (!shown || !orb) return;
    orb.showInactive();
    tell(`eliseOrb.pop(${JSON.stringify(state)})`);
  });
}

/** What the conversation is doing (listening, the person speaking, thinking, answering). */
export function setWakeOrbState(next: VoiceOrbState) {
  state = next;
  if (shown) tell(`eliseOrb.state(${JSON.stringify(next)})`);
}

// Only these fixed calls with a validated state reach the orb's page.
const tell = (code: string) => void orb?.webContents.executeJavaScript(code).catch(() => undefined);

export function closeWakeOrb() {
  orb?.destroy();
}
