import { z } from "zod";

import type { HomeRuntimeStatus } from "@/core/home/runtime";

import type { DiscoveredDevice, DiscoveryStep } from "../home/discovery";

/**
 * One ELISE, several surfaces (ADR-081). Product code asks "does this platform support X?",
 * never "is this Electron?". Web, Desktop and (later) Mobile each answer with a capability set
 * and a bridge protocol version; features gate on those, not on version strings.
 */
export const PLATFORM_KINDS = ["web", "desktop", "mobile"] as const;
export type PlatformKind = (typeof PLATFORM_KINDS)[number];

/** What a native surface can add on top of ELISE. Versioned names: a new shape is a new key. */
export const PLATFORM_CAPABILITIES = [
  "home_hub",
  "local_runtime",
  "native_notifications",
  "open_external",
  "start_at_login",
  "auto_update",
  "snapshot_cache",
  /** "ELISE" heard on this computer, locally, with the window hidden (ADR-095). */
  "wake_word",
] as const;
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

/** The renderer ↔ Desktop bridge contract. Bump on any breaking change to its methods. */
export const DESKTOP_BRIDGE_PROTOCOL_VERSION = 1;
/** The Desktop main process ↔ local runtime contract (ADR-081): independent of Electron. */
export const LOCAL_RUNTIME_PROTOCOL_VERSION = 1;

export interface PlatformInfo {
  kind: PlatformKind;
  capabilities: readonly PlatformCapability[];
  bridgeProtocolVersion: number | null;
}

export const WEB_PLATFORM: PlatformInfo = {
  kind: "web",
  capabilities: [],
  bridgeProtocolVersion: null,
};

export type FeatureSupport = "supported" | "unsupported" | "update_required";

/**
 * Whether a feature can run here. A Desktop that speaks an older protocol, or lacks the
 * capability while being Desktop, needs an update; any other platform simply doesn't offer it.
 */
export function featureSupport(
  platform: PlatformInfo,
  need: { capability: PlatformCapability; minProtocol?: number },
): FeatureSupport {
  if (platform.kind !== "desktop") return "unsupported";
  const protocol = platform.bridgeProtocolVersion ?? 0;
  if (protocol < (need.minProtocol ?? 1)) return "update_required";
  return platform.capabilities.includes(need.capability) ? "supported" : "update_required";
}

/** Connectivity is never one boolean: the cloud can be down while the home still answers. */
export interface EliseConnectivity {
  internet: "online" | "offline" | "unknown";
  cloud: "online" | "degraded" | "offline";
  localRuntime: "online" | "degraded" | "offline";
  home: "online" | "degraded" | "offline" | "not_configured";
}

export interface DesktopInfo {
  desktopVersion: string;
  rendererVersion: string;
  bridgeProtocolVersion: number;
  localRuntimeVersion: string | null;
  localRuntimeProtocolVersion: number;
  platform: "windows" | "macos" | "linux";
  arch: string;
  capabilities: PlatformCapability[];
  installationId: string;
  /** The ELISE Cloud this build talks to (baked at build time; public). */
  cloudOrigin: string;
  channel: "stable" | "beta";
}

export type DesktopUpdateState = (
  | { status: "idle" | "checking" | "not_available" | "unsupported" }
  | { status: "available" | "downloading"; version?: string }
  | { status: "ready"; version?: string }
  | { status: "error"; message: string }
) & {
  /** ELISE Cloud no longer serves this bridge protocol: updating is required (ADR-081). */
  required?: boolean;
};

export interface DesktopPreferences {
  startAtLogin: boolean;
  keepInBackground: boolean;
  notifications: boolean;
  /**
   * Listen for "ELISE" on this computer (ADR-095): off until the person turns it on (their
   * consent); detection is local, nothing is sent before the word.
   */
  wakeWord: boolean;
  /** A short, quiet sound when "ELISE" is heard. */
  wakeChime: boolean;
}

/**
 * Whether this computer should be listening for "ELISE" now (main → renderer): the person's
 * setting, a pause from the tray, and the system (locked screen, sleep).
 */
export interface WakeControl {
  enabled: boolean;
  paused: boolean;
  /** The screen is locked or the computer is going to sleep: never listen then. */
  suspended: boolean;
  chime: boolean;
}

/** What the listener is doing (renderer → main), for the tray and settings — never audio. */
export type WakeReport =
  | "off"
  | "starting"
  | "listening"
  | "paused"
  | "in_conversation"
  | "no_microphone"
  | "mic_denied"
  | "model_failed";

export interface DesktopSession {
  signedIn: boolean;
  userId: string | null;
  workspaceId: string | null;
}

/** The local Home as the runtime sees it: no secrets, no raw provider output. */
export interface HomeHubLocalState {
  /** The managed Home runtime on this computer (ADR-082). */
  runtime: HomeRuntimeStatus;
  /** Linked to the person's home in ELISE Cloud. */
  paired: boolean;
  providerConnected: boolean;
  devices: number;
}

/** A device as the local runtime knows it (keyed by the provider's stable key). */
export interface LocalHomeDevice {
  providerKey: string;
  name: string;
  type: string;
  capabilities: unknown[];
  state: Record<string, unknown>;
  available: boolean;
}

export const localHomeCommandSchema = z.object({
  providerKey: z.string().min(1).max(200),
  actions: z
    .array(
      z.object({ type: z.string().max(40), value: z.unknown(), relative: z.boolean().optional() }),
    )
    .min(1)
    .max(6),
});
export type LocalHomeCommand = z.infer<typeof localHomeCommandSchema>;

export type LocalHomeResult =
  { ok: true; state: Record<string, unknown> | null } | { ok: false; error: string };

/**
 * window.eliseDesktop (ADR-081): narrow, typed, versioned. Renderer code never sees channel
 * names; every call is validated again in the main process.
 */
export interface EliseDesktopBridge {
  readonly protocolVersion: number;
  getDesktopInfo(): Promise<DesktopInfo>;
  getConnectivity(): Promise<EliseConnectivity>;
  onConnectivity(listener: (c: EliseConnectivity) => void): () => void;
  openExternal(url: string): Promise<void>;
  getSession(): Promise<DesktopSession>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  onSession(listener: (s: DesktopSession) => void): () => void;
  /** Short-lived: the renderer never holds the refresh token. */
  getAccessToken(): Promise<string | null>;
  getUpdateState(): Promise<DesktopUpdateState>;
  onUpdate(listener: (s: DesktopUpdateState) => void): () => void;
  checkForUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  getHomeHubState(): Promise<HomeHubLocalState | null>;
  onHomeHub(listener: (s: HomeHubLocalState) => void): () => void;
  /** "Configurar ELISE Home" / "Reintentar". Progress arrives through onHomeHub. */
  setupHome(): Promise<void>;
  /** Turn on what Windows needs (asks for administrator permission at this step). */
  enableHomeRequirements(): Promise<void>;
  /** Only after the person chose "Reiniciar ahora". */
  restartComputer(): Promise<void>;
  /** Removes the local engine and its data (after confirmation). */
  resetHome(): Promise<void>;
  homeDiagnostics(): Promise<string>;
  listLocalHomeDevices(): Promise<LocalHomeDevice[]>;
  executeLocalHome(command: LocalHomeCommand): Promise<LocalHomeResult>;
  /** ADR-090: devices the home engine found on the network, and adding them. */
  listHomeDiscoveries(): Promise<DiscoveredDevice[]>;
  openHomeDiscovery(flowId: string): Promise<DiscoveryStep>;
  answerHomeDiscovery(
    flowId: string,
    answers: Record<string, string | number | boolean>,
  ): Promise<DiscoveryStep>;
  ignoreHomeDiscovery(flowId: string, name: string): Promise<boolean>;
  cacheGet(key: string): Promise<CachedSnapshot | null>;
  cacheSet(key: string, value: unknown, sourceUpdatedAt?: string | null): Promise<void>;
  onNavigate(listener: (path: string) => void): () => void;
  collectDiagnostics(): Promise<string>;
  /** ADR-095: the wake word's control (setting, pause, lock) and what the listener reports. */
  getWakeControl(): Promise<WakeControl>;
  onWakeControl(listener: (c: WakeControl) => void): () => void;
  setWakePaused(paused: boolean): Promise<WakeControl>;
  reportWake(status: WakeReport): Promise<void>;
  /** Only when the person asked to see ELISE ("abrí ELISE"): never on a wake word alone. */
  showApp(path?: string): Promise<void>;
}

export interface CachedSnapshot<T = unknown> {
  value: T;
  cachedAt: string;
  sourceUpdatedAt: string | null;
  scope: string;
  schemaVersion: number;
}
