import { z } from "zod";

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

export const HOME_RUNTIME_STATES = [
  "not_installed",
  "installing",
  "starting",
  "ready",
  "degraded",
  "stopped",
  "error",
  "update_required",
] as const;
export type HomeRuntimeState = (typeof HOME_RUNTIME_STATES)[number];

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
}

export interface DesktopSession {
  signedIn: boolean;
  userId: string | null;
  workspaceId: string | null;
}

/** The local Home as the runtime sees it: no secrets, no raw provider output. */
export interface HomeHubLocalState {
  runtime: HomeRuntimeState;
  paired: boolean;
  providerConnected: boolean;
  devices: number;
  message: string | null;
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
  getHomeHubState(): Promise<HomeHubLocalState>;
  listLocalHomeDevices(): Promise<LocalHomeDevice[]>;
  executeLocalHome(command: LocalHomeCommand): Promise<LocalHomeResult>;
  cacheGet(key: string): Promise<CachedSnapshot | null>;
  cacheSet(key: string, value: unknown, sourceUpdatedAt?: string | null): Promise<void>;
  onNavigate(listener: (path: string) => void): () => void;
  collectDiagnostics(): Promise<string>;
}

export interface CachedSnapshot<T = unknown> {
  value: T;
  cachedAt: string;
  sourceUpdatedAt: string | null;
  scope: string;
  schemaVersion: number;
}
