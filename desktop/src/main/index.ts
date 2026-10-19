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
import { handleSquirrelEvent, isInstalledBuild, stableExe } from "./squirrel";
import { loadState, updateState } from "./store";
import {
  checkForUpdates,
  initUpdater,
  markRequired,
  updates,
  updateState as currentUpdate,
} from "./updater";
import { applyWakeTo, setWakePaused, wake, wakeControl, wakeStatus, watchSystem } from "./wake";
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
// A local build (desktop/out, `electron .`) gets its own profile: its own single-instance lock
// and data, so it can never stand in for — or break — the installed ELISE.
else if (!installerEvent && !isInstalledBuild())
  app.setPath("userData", join(app.getPath("appData"), "ELISE (local build)"));

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const host = new RuntimeHost();
const pendingLinks: string[] = [];

/** Whether this build may own elise:// (installed; local builds only when QA asks for it). */
const ownsProtocol = () =>
  isInstalledBuild() || process.env.ELISE_DESKTOP_REGISTER_PROTOCOL === "1";

function registerProtocolClient() {
  if (!ownsProtocol()) return;
  if (process.defaultApp && process.argv[1])
    app.setAsDefaultProtocolClient("elise", process.execPath, [resolve(process.argv[1])]);
  else app.setAsDefaultProtocolClient("elise", stableExe());
}

/**
 * Local builds once registered themselves at login as "electron.app.ELISE" (pointing into
 * desktop/out). The installed ELISE removes that stale entry so only it starts with Windows.
 */
const LOCAL_BUILD_LOGIN_ITEM = "electron.app.ELISE";

function applyLoginItem() {
  if (!isInstalledBuild()) return; // never register a local or development build at login
  const { startAtLogin } = loadState().preferences;
  app.setLoginItemSettings({ openAtLogin: startAtLogin, path: stableExe(), args: [HIDDEN_ARG] });
  if (process.platform === "win32")
    app.setLoginItemSettings({ openAtLogin: false, name: LOCAL_BUILD_LOGIN_ITEM });
}

const openedHidden = () =>
  process.argv.includes(HIDDEN_ARG) || app.getLoginItemSettings().wasOpenedAtLogin === true;

/** The wake word's model: inside the installed app, or desktop/assets/wake in development. */
const wakeModelDir = () =>
  app.isPackaged
    ? join(process.resourcesPath, "assets", "wake")
    : join(__dirname, "../../assets/wake");

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
  win.loadURL(`${APP_ORIGIN}${path}`).catch(async (error: Error) => {
    log("desktop_load_failed", { attempt, message: error.message.slice(0, 120) });
    if (attempt < 5)
      return void setTimeout(() => loadApp(win, path, attempt + 1), 1000 * (attempt + 1));
    // Still nothing: say so and let the person choose, instead of a silent dark window.
    if (win.isDestroyed()) return;
    const w = words();
    const { response } = await dialog.showMessageBox(win, {
      type: "error",
      message: "ELISE",
      detail: w.crashed,
      buttons: [w.retry, w.restart, w.quit],
    });
    if (response === 0) loadApp(win, path);
    else if (response === 1) {
      app.relaunch();
      quit();
    } else quit();
  });
}

/** Maximized last time but created hidden: maximize() would show it, so it waits for a show. */
let maximizeOnShow = false;

function createWindow(path = "/", opts: { hidden?: boolean } = {}) {
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
  // Hidden (ADR-095: started at login to listen for "ELISE"): never shown, never focused, until
  // the person opens it. maximize() and "ready-to-show" would both show it.
  if (saved?.maximized && !opts.hidden) win.maximize();
  maximizeOnShow = Boolean(saved?.maximized && opts.hidden);
  if (!opts.hidden) win.once("ready-to-show", () => win.show());
  applyWakeTo(win);
  // A deep link that opens the window goes straight to its page (nothing to lose in transit).
  loadApp(win, path);

  const remember = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    updateState((s) => ({ ...s, window: { ...b, maximized: win.isMaximized() } }));
  };
  // ADR-095: the window only appears when the person opens it — logged, so it can be checked.
  win.on("show", () => log("desktop_window_shown"));
  win.on("focus", () => log("desktop_window_focused"));
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
  if (maximizeOnShow) {
    maximizeOnShow = false;
    window.maximize();
  }
  window.show();
  window.focus();
  const contents = window.webContents;
  // Its page died while hidden: bring it back (at the asked page) instead of showing it empty.
  if (contents.isCrashed()) return loadApp(window, path);
  if (!path) return;
  // Still loading: the page can't hear yet (its listener mounts after load), so load the asked
  // page itself instead of sending a message nobody receives.
  if (contents.isLoading()) loadApp(window, path);
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
  // ADR-095: what the "ELISE" listener is doing, and a pause within reach (meetings).
  const wc = wakeControl();
  const listen = wc.enabled
    ? [
        { label: w.wake(wakeStatus(), wc), enabled: false },
        wc.paused
          ? { label: w.resumeListening, click: () => void setWakePaused(false) }
          : { label: w.pauseListening, click: () => void setWakePaused(true) },
      ]
    : [];
  tray.setToolTip(c.cloud === "online" ? `ELISE · ${w.connected}` : `ELISE · ${w.cloudOffline}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "ELISE", enabled: false },
      { label: c.cloud === "online" ? `● ${w.connected}` : `○ ${w.cloudOffline}`, enabled: false },
      { type: "separator" },
      { label: w.open, click: () => showWindow() },
      ...listen,
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
  // "Abrir ELISE Desktop" on the web waits for presence: announce it now, not in a minute.
  void heartbeat(true);
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
  handleAppProtocol(RENDERER_DIR, DEV_URL, wakeModelDir());
  host.start();
  registerIpc(host, applyLoginItem, (path) => showWindow(path));
  watchSystem();
  wake.on("change", () => refreshTray());
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

  // Started by a link: the link opens the window, already on its page (nothing to lose in
  // transit). Otherwise the usual window, unless started hidden at login.
  for (const link of pendingLinks.splice(0)) void handleDeepLink(link);
  // No link, or only rejected ones (a link opens its window synchronously): the usual window.
  if ((!window || window.isDestroyed()) && !openedHidden()) showWindow();
  // Started at login with "ELISE" on: the app runs hidden (its renderer listens), no window shown.
  else if ((!window || window.isDestroyed()) && wakeControl().enabled)
    window = createWindow("/", { hidden: true });

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

// ── Start ────────────────────────────────────────────────────────────────────
// Last, after every module-level binding above exists. It used to run first: a cold start from
// a link (elise://…, what the web's "Abrir ELISE Desktop" sends) queued it into `pendingLinks`
// before that was initialized, main() threw, and ELISE hung with no window.
if (installerEvent) {
  // handled in squirrel.ts; the app quits when Update.exe is done
} else if (!app.requestSingleInstanceLock()) {
  // A second launch hands its arguments (deep link) to the first and exits: one runtime only.
  app.quit();
} else {
  main().catch((error: Error) => {
    // Never a silent hang: say so, keep the reason in the log, and let the person reopen it.
    log("desktop_start_failed", { message: error.message.slice(0, 200) });
    dialog.showErrorBox("ELISE", words().crashed);
    app.exit(1); // no automatic relaunch: a failure that repeats must not loop
  });
}
