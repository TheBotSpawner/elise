import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Tray } from "electron";
import { join, resolve } from "node:path";

import { parseDeepLink } from "@/core/platform/links";

import * as cloud from "./cloud";
import { configureHome } from "./home";
import { words } from "./i18n";
import { connectivity, desktopInfo, registerIpc } from "./ipc";
import { log } from "./log";
import { APP_ORIGIN, handleAppProtocol, registerSchemes } from "./protocol";
import { RuntimeHost } from "./runtime-host";
import { hardenSessions } from "./security";
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

registerSchemes();
// Automated validation runs an unpackaged build against a throwaway profile directory.
if (!app.isPackaged && process.env.ELISE_DESKTOP_USER_DATA)
  app.setPath("userData", process.env.ELISE_DESKTOP_USER_DATA);

if (!app.requestSingleInstanceLock()) {
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
  else app.setAsDefaultProtocolClient("elise");
}

function applyLoginItem() {
  if (!app.isPackaged) return; // never register a development build at login
  const { startAtLogin } = loadState().preferences;
  app.setLoginItemSettings({ openAtLogin: startAtLogin, args: [HIDDEN_ARG] });
}

const openedHidden = () =>
  process.argv.includes(HIDDEN_ARG) || app.getLoginItemSettings().wasOpenedAtLogin === true;

function iconPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "assets", "icon.png")
    : join(__dirname, "../../assets/icon.png");
}

function createWindow() {
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
  void win.loadURL(`${APP_ORIGIN}/`);

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

  // A crashed renderer comes back by itself, a few times; then the person decides.
  let crashes: number[] = [];
  win.webContents.on("render-process-gone", async (_e, details) => {
    log("desktop_renderer_gone", { reason: details.reason });
    if (details.reason === "clean-exit") return;
    const now = Date.now();
    crashes = [...crashes.filter((t) => now - t < 60_000), now];
    if (crashes.length <= 3) return void win.loadURL(`${APP_ORIGIN}/`);
    const w = words();
    const { response } = await dialog.showMessageBox(win, {
      type: "error",
      message: "ELISE",
      detail: w.crashed,
      buttons: [w.retry, w.restart, w.quit],
    });
    if (response === 0) {
      crashes = [];
      void win.loadURL(`${APP_ORIGIN}/`);
    } else if (response === 1) {
      app.relaunch();
      quit();
    } else quit();
  });
  win.webContents.on("unresponsive", () => log("desktop_renderer_unresponsive"));
  return win;
}

function showWindow(path?: string) {
  if (!window || window.isDestroyed()) window = createWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (path) window.webContents.send(EVENTS.navigate, path);
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
        : host.home.runtime === "starting"
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
async function heartbeat() {
  if (!cloud.session().signedIn || cloud.cloudState().cloud !== "online") return;
  if (Date.now() - lastHeartbeat < 60_000) return;
  lastHeartbeat = Date.now();
  const info = desktopInfo(host);
  const res = await cloud
    .cloudFetch("/api/desktop/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        installationId: info.installationId,
        platform: info.platform,
        desktopVersion: info.desktopVersion,
        bridgeProtocolVersion: info.bridgeProtocolVersion,
        capabilities: info.capabilities,
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
    void heartbeat();
  });
  host.on("home", () => {
    broadcast(EVENTS.connectivity, connectivity(host));
    refreshTray();
  });
  updates.on("state", (s) => {
    refreshTray();
    broadcast(EVENTS.update, s);
  });

  await cloud.probeNow();
  cloud.watchCloud();
  void configureHome(host);
  setInterval(() => void heartbeat(), 5 * 60_000);

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
