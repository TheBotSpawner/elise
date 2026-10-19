/**
 * IPC channel names: known only to the preload and the main process (ADR-081). Renderer code
 * calls typed bridge methods and never sees these.
 */
export const INVOKE = {
  desktopInfo: "elise:desktop-info",
  connectivity: "elise:connectivity",
  openExternal: "elise:open-external",
  session: "elise:session",
  signIn: "elise:sign-in",
  signOut: "elise:sign-out",
  accessToken: "elise:access-token",
  updateState: "elise:update-state",
  checkUpdates: "elise:check-updates",
  installUpdate: "elise:install-update",
  getPreferences: "elise:get-preferences",
  setPreferences: "elise:set-preferences",
  homeState: "elise:home-state",
  homeSetup: "elise:home-setup",
  homeEnable: "elise:home-enable",
  homeReset: "elise:home-reset",
  homeDiagnostics: "elise:home-diagnostics",
  restartComputer: "elise:restart-computer",
  homeDevices: "elise:home-devices",
  homeExecute: "elise:home-execute",
  homeDiscoveries: "elise:home-discoveries",
  homeDiscoveryOpen: "elise:home-discovery-open",
  homeDiscoveryAnswer: "elise:home-discovery-answer",
  homeDiscoveryIgnore: "elise:home-discovery-ignore",
  cacheGet: "elise:cache-get",
  cacheSet: "elise:cache-set",
  diagnostics: "elise:diagnostics",
  wakeControl: "elise:wake-control",
  wakePause: "elise:wake-pause",
  wakeReport: "elise:wake-report",
  showApp: "elise:show-app",
} as const;

export const EVENTS = {
  connectivity: "elise:on-connectivity",
  session: "elise:on-session",
  navigate: "elise:on-navigate",
  update: "elise:on-update",
  home: "elise:on-home",
  wake: "elise:on-wake",
} as const;
