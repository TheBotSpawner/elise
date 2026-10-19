import { BrowserWindow, screen } from "electron";

import type { VoiceOrbState, WakeReport } from "@/core/platform/platform";

import { APP_ORIGIN } from "./protocol";

/**
 * A voice conversation in the background (ADR-095): ELISE's Orb in the bottom-right corner while
 * she listens to the person or answers — never while she only waits for "ELISE". It never takes
 * focus or clicks (the active app keeps both) and hides while ELISE's own window is in use. Its
 * page draws ELISE's Orb and nothing else: no preload, no bridge.
 */
/** Sized by the screen: 7.5 % of its height (80–140 px), so it reads at any resolution. */
const sizeFor = (height: number) => Math.round(Math.min(140, Math.max(80, height * 0.075)));
let orb: BrowserWindow | null = null;
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
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "floating");
  win.on("closed", () => {
    orb = null;
    shown = false;
  });
  return win;
}

/** `appInUse`: ELISE's own window is visible and focused (the orb would only repeat it). */
export function updateWakeOrb(status: WakeReport, enabled: boolean, appInUse: boolean) {
  const want = enabled && !appInUse && status === "in_conversation";
  if (want === shown) return;
  shown = want;
  if (!want) return orb?.hide();
  // Shown without activation: the app in front keeps its focus; it pops in, so it's noticed.
  const show = () => {
    if (!shown || !orb) return;
    orb.showInactive();
    tell(`eliseOrb.pop(${JSON.stringify(state)})`);
  };
  if (orb) return show();
  orb = create();
  void orb.loadURL(PAGE).then(show);
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
