import { contextBridge, ipcRenderer } from "electron";

import { DESKTOP_BRIDGE_PROTOCOL_VERSION, type EliseDesktopBridge } from "@/core/platform/platform";

import { EVENTS, INVOKE } from "../shared/channels";

/**
 * window.eliseDesktop (ADR-081): a frozen, typed API. No ipcRenderer, no Node, no channel names
 * reach the page; listeners get data only (never the IPC event). The main process validates
 * every call again.
 */
const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

function subscribe<T>(channel: string, listener: (value: T) => void) {
  const handler = (_e: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => void ipcRenderer.removeListener(channel, handler);
}

const bridge: EliseDesktopBridge = {
  protocolVersion: DESKTOP_BRIDGE_PROTOCOL_VERSION,
  getDesktopInfo: () => invoke(INVOKE.desktopInfo),
  getConnectivity: () => invoke(INVOKE.connectivity),
  onConnectivity: (l) => subscribe(EVENTS.connectivity, l),
  openExternal: (url) => invoke(INVOKE.openExternal, url),
  getSession: () => invoke(INVOKE.session),
  signIn: () => invoke(INVOKE.signIn),
  signOut: () => invoke(INVOKE.signOut),
  onSession: (l) => subscribe(EVENTS.session, l),
  getAccessToken: () => invoke(INVOKE.accessToken),
  getUpdateState: () => invoke(INVOKE.updateState),
  onUpdate: (l) => subscribe(EVENTS.update, l),
  checkForUpdates: () => invoke(INVOKE.checkUpdates),
  installUpdate: () => invoke(INVOKE.installUpdate),
  getPreferences: () => invoke(INVOKE.getPreferences),
  setPreferences: (patch) => invoke(INVOKE.setPreferences, patch),
  getHomeHubState: () => invoke(INVOKE.homeState),
  onHomeHub: (l) => subscribe(EVENTS.home, l),
  setupHome: () => invoke(INVOKE.homeSetup),
  enableHomeRequirements: () => invoke(INVOKE.homeEnable),
  restartComputer: () => invoke(INVOKE.restartComputer),
  resetHome: () => invoke(INVOKE.homeReset),
  homeDiagnostics: () => invoke(INVOKE.homeDiagnostics),
  listLocalHomeDevices: () => invoke(INVOKE.homeDevices),
  executeLocalHome: (command) => invoke(INVOKE.homeExecute, command),
  listHomeDiscoveries: () => invoke(INVOKE.homeDiscoveries),
  openHomeDiscovery: (flowId) => invoke(INVOKE.homeDiscoveryOpen, { flowId }),
  answerHomeDiscovery: (flowId, answers) => invoke(INVOKE.homeDiscoveryAnswer, { flowId, answers }),
  ignoreHomeDiscovery: (flowId, name) => invoke(INVOKE.homeDiscoveryIgnore, { flowId, name }),
  cacheGet: (key) => invoke(INVOKE.cacheGet, key),
  cacheSet: (key, value, sourceUpdatedAt) =>
    invoke(INVOKE.cacheSet, key, value, sourceUpdatedAt ?? null),
  onNavigate: (l) => subscribe(EVENTS.navigate, l),
  collectDiagnostics: () => invoke(INVOKE.diagnostics),
  getWakeControl: () => invoke(INVOKE.wakeControl),
  onWakeControl: (l) => subscribe(EVENTS.wake, l),
  onVoiceEnd: (l) => subscribe(EVENTS.voiceEnd, () => l()),
  setWakePaused: (paused) => invoke(INVOKE.wakePause, paused),
  reportWake: (status) => invoke(INVOKE.wakeReport, status),
  reportVoiceOrb: (state) => invoke(INVOKE.voiceOrb, state),
  showApp: (path) => invoke(INVOKE.showApp, path ?? null),
};

contextBridge.exposeInMainWorld("eliseDesktop", Object.freeze(bridge));
