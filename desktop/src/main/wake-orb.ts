import { BrowserWindow, screen } from "electron";
import { EventEmitter } from "node:events";

import type { VoiceOrbState, WakeOrbCorner, WakeReport } from "@/core/platform/platform";

import { log } from "./log";
import { APP_ORIGIN } from "./protocol";

/**
 * A voice conversation in the background (ADR-095, ADR-102): ELISE's Orb in a corner of the
 * screen the person is using while she listens to them or answers — never while she only waits
 * for "ELISE", never while ELISE's own window is the one in use. It never takes focus (the active
 * app keeps it); a tap on it ends the conversation. A small eye on its left brings ELISE's window
 * to the front. Its page draws ELISE's Orb and nothing else: no preload, no bridge — a tap
 * reaches here as an in-page navigation to "#end" (the orb) or "#show" (the eye).
 *
 * Reliability (ADR-102): placed at every show on the display under the pointer (where the person
 * works; monitors and scaling change after login), raised above other always-on-top windows, and
 * recreated when its page failed to load or its renderer died. Only states are logged.
 */
export const wakeOrb = new EventEmitter();

/** Sized by the screen: 7.5 % of its height (80–140 px), so it reads at any resolution. */
const sizeFor = (height: number) => Math.round(Math.min(140, Math.max(80, height * 0.075)));
let orb: BrowserWindow | null = null;
/** The page has loaded (true) or failed (false): it can show at once when a conversation starts. */
let ready: Promise<boolean> | null = null;
let shown = false;
let state: VoiceOrbState = "listening";
let corner: WakeOrbCorner = "bottom-right";
/** Safe trace ids: which conversation's orb, and when it was asked for. */
let showId = 0;
let askedAt = 0;
/** Recreations in a row without a successful show: a page that never loads isn't retried forever. */
let failures = 0;

/** ELISE's own Orb renderer (renderer/orb.html). */
const PAGE = `${APP_ORIGIN}/orb.html`;

/** The display the person is working on: the one under the pointer (no focus needed to know). */
const activeDisplay = () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

function boundsFor(display: Electron.Display, where: WakeOrbCorner) {
  const { workArea } = display;
  const SIZE = sizeFor(workArea.height);
  // Away from the edge, and clear of an auto-hidden taskbar (the work area then reaches it).
  const MARGIN = Math.round(SIZE * 0.3);
  const EDGE = Math.round(SIZE * 0.45);
  // The eye overlaps the orb's left edge by half its width (orb.html draws it there).
  const EYE = Math.round(SIZE * 0.24);
  const width = SIZE + Math.round(EYE / 2);
  const right = where.endsWith("right");
  const bottom = where.startsWith("bottom");
  return {
    width,
    height: SIZE,
    x: right ? workArea.x + workArea.width - width - MARGIN : workArea.x + MARGIN,
    y: bottom ? workArea.y + workArea.height - SIZE - EDGE : workArea.y + EDGE,
  };
}

function create() {
  const win = new BrowserWindow({
    ...boundsFor(activeDisplay(), corner),
    useContentSize: true,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    // "Show desktop" (Win+D) must not leave it minimized for the rest of the conversation.
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // Clickable, never activated: a tap doesn't take focus from the app in front.
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    // Hidden, it draws nothing: no animation frames while ELISE only waits for her name.
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
    },
  });
  // Above other always-on-top windows too (normal apps, a maximized Chrome).
  win.setAlwaysOnTop(true, "screen-saver");
  // Its page goes nowhere else; "#end" and "#show" are the only things it says.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("did-navigate-in-page", (_e, url) => {
    const hash = new URL(url).hash;
    // The eye: ELISE to the front; the conversation goes on there (the orb then hides itself).
    if (hash.startsWith("#show")) return void wakeOrb.emit("show");
    if (!hash.startsWith("#end")) return;
    shown = false;
    log("desktop_orb_tapped", { id: showId });
    wakeOrb.emit("end");
    // After its shrink-away (orb.html), unless a new conversation already brought it back.
    setTimeout(() => !shown && !win.isDestroyed() && win.hide(), 250);
  });
  // A GPU reset or a crash leaves an empty transparent window: start over (at the next show
  // if none is due now).
  win.webContents.on("render-process-gone", (_e, d) => recreate(win, `gone:${d.reason}`));
  win.on("unresponsive", () => recreate(win, "unresponsive"));
  win.on("closed", () => {
    if (orb === win) {
      orb = null;
      ready = null;
    }
  });
  orb = win;
  ready = win
    .loadURL(PAGE)
    .then(() => true)
    .catch((error: Error) => {
      log("desktop_orb_load_failed", { message: error.message.slice(0, 120) });
      return false;
    });
  return win;
}

function recreate(win: BrowserWindow, reason: string) {
  if (orb !== win) return;
  failures++;
  log("desktop_orb_recreated", { reason, failures });
  orb = null;
  ready = null;
  if (!win.isDestroyed()) win.destroy();
  // The chime already said "I heard you": past three failures, the orb waits for the next one.
  if (shown && failures <= 3) {
    shown = false;
    present();
  }
}

/** Shows it inactive on the active display, raised; verified and logged. */
function present() {
  shown = true;
  const id = ++showId;
  askedAt = Date.now();
  const win = orb ?? create();
  void ready?.then((ok) => {
    if (!shown || id !== showId || orb !== win || win.isDestroyed()) return;
    // A page that never loaded would show nothing: once more, from scratch.
    if (!ok) return recreate(win, "load_failed");
    const display = activeDisplay();
    win.setBounds(boundsFor(display, corner));
    win.setAlwaysOnTop(true, "screen-saver");
    win.showInactive();
    win.moveTop();
    tell(win, `eliseOrb.pop(${JSON.stringify(state)})`);
    failures = 0;
    log("desktop_orb_shown", {
      id,
      ms: Date.now() - askedAt,
      visible: win.isVisible(),
      display: screen.getAllDisplays().findIndex((d) => d.id === display.id),
      scale: display.scaleFactor,
    });
  });
}

/**
 * `appInUse`: ELISE's own window is in front (the orb would only repeat it). While "ELISE" is on,
 * the orb's window is kept loaded and hidden, so it appears the moment a conversation starts.
 */
export function updateWakeOrb(
  status: WakeReport,
  enabled: boolean,
  appInUse: boolean,
  where: WakeOrbCorner = "bottom-right",
) {
  corner = where;
  if (enabled && !orb) create();
  const want = enabled && !appInUse && status === "in_conversation";
  if (want === shown) return;
  if (!want) {
    shown = false;
    log("desktop_orb_hidden", { id: showId, status, appInUse });
    return orb?.hide();
  }
  present();
}

/** What the conversation is doing (listening, the person speaking, thinking, answering). */
export function setWakeOrbState(next: VoiceOrbState) {
  state = next;
  if (shown && orb) tell(orb, `eliseOrb.state(${JSON.stringify(next)})`);
}

/** Monitors plugged, unplugged or rescaled: a shown orb moves to where the person is. */
export function watchDisplays() {
  const move = () => {
    if (!shown || !orb || orb.isDestroyed()) return;
    orb.setBounds(boundsFor(activeDisplay(), corner));
    log("desktop_orb_moved", { id: showId });
  };
  screen.on("display-added", move);
  screen.on("display-removed", move);
  screen.on("display-metrics-changed", move);
}

/** The orb's own window: it keeps background throttling (it draws nothing while hidden). */
export const isWakeOrbWindow = (win: BrowserWindow) => win === orb;

// Only these fixed calls with a validated state reach the orb's page.
const tell = (win: BrowserWindow, code: string) =>
  void win.webContents.executeJavaScript(code).catch(() => undefined);

export function closeWakeOrb() {
  shown = false;
  orb?.destroy();
}
