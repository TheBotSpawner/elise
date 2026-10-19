import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Tray } from "electron";
import { join, resolve } from "node:path";

import { HOME_RUNTIME_BUSY, progressPercent } from "@/core/home/runtime";
import { parseDeepLink } from "@/core/platform/links";
import type { HomeHubLocalState } from "@/core/platform/platform";

import * as cloud from "./cloud";
import { computerName, configureHome, watchHome } from "./home";
import { words } from "./i18n";
import { connectivity, desktopInfo, registerIpc } from "./ipc";
import { log } from "./log";
import { APP_ORIGIN, handleAppProtocol, registerSchemes } from "./protocol";
import { RuntimeHost } from "./runtime-host";
import { hardenSessions } from "./security";
import { handleSquirrelEvent, stableExe } from "./squirrel";
import { loadState, updateState } from "./store";
import {
  checkForUpdates,
  initUpdater,
  markRequired,
  updates,
  updateState as currentUpdate,
} from "./updater";
import { EVENTS } from "../shared/channels";

/**
 * ELISE Desktop main process (ADR-081): a shell, not the product. It owns the window, the tray,
 * deep links, start-at-login, updates and the local runtime's lifecycle; ELISE itself (rules,
 * tools, Home model, UI) is the shared source in src/.
 */
const DEV_URL =
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined"
    ? MAIN_WINDOW_VITE_DEV_SERVER_URL
    : undefined;
const RENDERER_DIR = join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`);
const HIDDEN_ARG = "--background";

// Installer chores (Windows) run and exit before anything else starts.
const installerEvent = handleSquirrelEvent();
if (!installerEvent) registerSchemes();
// Automated validation runs an unpackaged build against a throwaway profile directory.
if (!app.isPackaged && process.env.ELISE_DESKTOP_USER_DATA)
  app.setPath("userData", process.env.ELISE_DESKTOP_USER_DATA);

if (installerEvent) {
  // handled in squirrel.ts; the app quits when Update.exe is done
} else if (!app.requestSingleInstanceLock()) {
  // A second launch hands its arguments (deep link) to the first and exits: one runtime only.
  app.quit();
} else {
  void main();
}

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const host = new RuntimeHost();
const pendingLinks: string[] = [];

function registerProtocolClient() {
  if (process.defaultApp && process.argv[1])
    app.setAsDefaultProtocolClient("elise", process.execPath, [resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient("elise", stableExe());
}

function applyLoginItem() {
  if (!app.isPackaged) return; // never register a development build at login
  const { startAtLogin } = loadState().preferences;
  app.setLoginItemSettings({ openAtLogin: startAtLogin, path: stableExe(), args: [HIDDEN_ARG] });
}

const openedHidden = () =>
  process.argv.includes(HIDDEN_ARG) || app.getLoginItemSettings().wasOpenedAtLogin === true;

function iconPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "assets", "icon.png")
    : join(__dirname, "../../assets/icon.png");
}

/**
 * (Re)loads the app. A failed load is retried with a pause: a window must never be left on its
 * dark background with nothing in it.
 */
function loadApp(win: BrowserWindow, path = "/", attempt = 0) {
  if (win.isDestroyed()) return;
  win.loadURL(`${APP_ORIGIN}${path}`).catch((error: Error) => {
    log("desktop_load_failed", { attempt, message: error.message.slice(0, 120) });
    if (attempt < 5) setTimeout(() => loadApp(win, path, attempt + 1), 1000 * (attempt + 1));
  });
}

function createWindow(path = "/") {
  const saved = loadState().window;
  const win = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 840,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 400,
    minHeight: 560,
    show: false,
    title: "ELISE",
    icon: iconPath(),
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#05080a" : "#f3f6f7",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  if (saved?.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  // A deep link that opens the window goes straight to its page (nothing to lose in transit).
  loadApp(win, path);

  const remember = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    updateState((s) => ({ ...s, window: { ...b, maximized: win.isMaximized() } }));
  };
  win.on("resized", remember);
  win.on("moved", remember);

  // Closing the window keeps ELISE (and ELISE Home) running in the tray; "Salir" really quits.
  win.on("close", (e) => {
    remember();
    if (!quitting && loadState().preferences.keepInBackground) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => (window = null));

  // A crashed or killed renderer (memory pressure, sleep, a GPU reset…) comes back by itself, a
  // few times; then the person decides. Reloading inside the event itself can be dropped, so it
  // waits a tick.
  let crashes: number[] = [];
  win.webContents.on("render-process-gone", async (_e, details) => {
    log("desktop_renderer_gone", { reason: details.reason });
    if (details.reason === "clean-exit") return;
    const now = Date.now();
    crashes = [...crashes.filter((t) => now - t < 60_000), now];
    if (crashes.length <= 3) return void setTimeout(() => loadApp(win), 300);
    const w = words();
    const { response } = await dialog.showMessageBox(win, {
      type: "error",
      message: "ELISE",
      detail: w.crashed,
      buttons: [w.retry, w.restart, w.quit],
    });
    if (response === 0) {
      crashes = [];
      loadApp(win);
    } else if (response === 1) {
      app.relaunch();
      quit();
    } else quit();
  });
  // A page hung for 8 s is restarted (the handler above brings it back) instead of staying frozen.
  let hung: ReturnType<typeof setTimeout> | null = null;
  win.webContents.on("unresponsive", () => {
    log("desktop_renderer_unresponsive");
    hung ??= setTimeout(() => {
      hung = null;
      if (!win.isDestroyed()) win.webContents.forcefullyCrashRenderer();
    }, 8000);
  });
  win.webContents.on("responsive", () => {
    if (hung) clearTimeout(hung);
    hung = null;
  });
  return win;
}

function showWindow(path?: string) {
  if (!window || window.isDestroyed()) {
    window = createWindow(path);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  const contents = window.webContents;
  // Its page died while hidden: bring it back (at the asked page) instead of showing it empty.
  if (contents.isCrashed()) return loadApp(window, path);
  if (!path) return;
  // Still loading: the page can't hear yet; tell it once it can.
  if (contents.isLoading())
    contents.once("did-finish-load", () => contents.send(EVENTS.navigate, path));
  else contents.send(EVENTS.navigate, path);
}

function broadcast(channel: string, value: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, value);
}

function refreshTray() {
  if (!tray) return;
  const w = words();
  const c = connectivity(host);
  const home =
    c.home === "not_configured"
      ? null
      : c.home === "online"
        ? w.homeReady
        : host.home && HOME_RUNTIME_BUSY.has(host.home.runtime.phase)
          ? w.homeStarting
          : w.homeOffline;
  const ready = currentUpdate().status === "ready";
  tray.setToolTip(c.cloud === "online" ? `ELISE · ${w.connected}` : `ELISE · ${w.cloudOffline}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "ELISE", enabled: false },
      { label: c.cloud === "online" ? `● ${w.connected}` : `○ ${w.cloudOffline}`, enabled: false },
      { type: "separator" },
      { label: w.open, click: () => showWindow() },
      ...(home ? [{ label: w.home(home), click: () => showWindow("/my-elise/home") }] : []),
      ready
        ? { label: w.restartToUpdate, click: () => void restartToUpdate() }
        : { label: w.checkUpdates, click: () => checkForUpdates() },
      { label: w.settings, click: () => showWindow("/settings") },
      { type: "separator" },
      { label: w.quit, click: () => quit() },
    ]),
  );
}

async function restartToUpdate() {
  quitting = true;
  await host.stop();
  const { installUpdate } = await import("./updater");
  installUpdate();
}

function quit() {
  quitting = true;
  app.quit();
}

async function handleDeepLink(raw: string) {
  const link = parseDeepLink(raw);
  if (!link) return log("desktop_deep_link_rejected");
  log("desktop_deep_link", { kind: link.kind });
  if (link.kind === "auth_callback") {
    showWindow();
    await cloud.completeSignIn(link.code, link.state);
    return;
  }
  showWindow(link.path);
}

let lastHeartbeat = 0;
let lastPhase = "";
/**
 * Presence (ADR-081/082): every minute, every 10 s while ELISE Home is being prepared (the web
 * shows that progress), and at once when the phase changes or someone signs in.
 */
async function heartbeat(force = false) {
  if (!cloud.session().signedIn || cloud.cloudState().cloud !== "online") return;
  const runtime = host.home?.runtime;
  const busy = runtime ? HOME_RUNTIME_BUSY.has(runtime.phase) : false;
  if (!force && Date.now() - lastHeartbeat < (busy ? 10_000 : 55_000)) return;
  lastHeartbeat = Date.now();
  const info = desktopInfo(host);
  const res = await cloud
    .cloudFetch("/api/desktop/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: info.installationId,
        name: computerName(),
        platform: info.platform,
        desktopVersion: info.desktopVersion,
        bridgeProtocolVersion: info.bridgeProtocolVersion,
        capabilities: info.capabilities,
        homeRuntime: runtime
          ? {
              phase: runtime.phase,
              enabled: runtime.enabled,
              progress: progressPercent(runtime.progress),
            }
          : null,
      }),
    })
    .catch(() => undefined);
  if (res?.ok)
    markRequired(((await res.json()) as { updateRequired?: boolean }).updateRequired === true);
}

async function main() {
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith("elise://"));
    if (link) void handleDeepLink(link);
    else showWindow();
  });
  app.on("open-url", (e, url) => {
    e.preventDefault();
    if (app.isReady()) void handleDeepLink(url);
    else pendingLinks.push(url);
  });
  const initial = process.argv.find((a) => a.startsWith("elise://"));
  if (initial) pendingLinks.push(initial);

  await app.whenReady();
  log("desktop_started", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    dev: Boolean(DEV_URL),
  });
  registerProtocolClient();
  loadState();
  cloud.initCloud();
  await cloud.adoptTestSession();
  hardenSessions();
  handleAppProtocol(RENDERER_DIR, DEV_URL);
  host.start();
  registerIpc(host, applyLoginItem);
  applyLoginItem();
  initUpdater();

  tray = new Tray(nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }));
  tray.on("click", () => showWindow());
  refreshTray();

  cloud.events.on("connectivity", () => {
    broadcast(EVENTS.connectivity, connectivity(host));
    refreshTray();
    if (cloud.cloudState().cloud === "online") {
      void heartbeat();
      if (!cloud.hubToken()) void configureHome(host);
    }
  });
  cloud.events.on("session", () => {
    broadcast(EVENTS.session, cloud.session());
    void configureHome(host);
    void heartbeat(true);
  });
  watchHome(host);
  host.on("home", (state: HomeHubLocalState) => {
    broadcast(EVENTS.home, state);
    broadcast(EVENTS.connectivity, connectivity(host));
    refreshTray();
    const phaseChanged = state.runtime.phase !== lastPhase;
    lastPhase = state.runtime.phase;
    void heartbeat(phaseChanged);
  });
  updates.on("state", (s) => {
    refreshTray();
    broadcast(EVENTS.update, s);
  });

  await cloud.probeNow();
  cloud.watchCloud();
  void configureHome(host);
  setInterval(() => void heartbeat(), 10_000);

  if (!openedHidden() || pendingLinks.length) showWindow();
  for (const link of pendingLinks.splice(0)) void handleDeepLink(link);

  app.on("activate", () => showWindow());
  // Background by design: no windows ≠ quit (the tray stays). Quit is explicit.
  app.on("window-all-closed", () => {
    if (!loadState().preferences.keepInBackground) quit();
  });
  let stopped = false;
  app.on("before-quit", (e) => {
    quitting = true;
    if (stopped) return;
    e.preventDefault();
    void host.stop().finally(() => {
      stopped = true;
      log("desktop_quit");
      app.quit();
    });
  });
}
