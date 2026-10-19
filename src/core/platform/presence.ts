import type { HomeSetupState } from "@/core/home/model";
import type { HomeRuntimePhase } from "@/core/home/runtime";

/**
 * Desktop presence for Hogar's setup (ADR-081/082). The browser never guesses what's installed:
 * a computer counts only when its authenticated heartbeat — this person, this workspace, a
 * protocol this backend still serves — arrived recently.
 */
export const MIN_DESKTOP_BRIDGE_PROTOCOL = 1;
/** Heartbeats come every minute (every 10 s while preparing ELISE Home). */
export const DESKTOP_OFFLINE_AFTER_MS = 3 * 60_000;

export interface DesktopPresence {
  installationId: string;
  name: string;
  platform: "windows" | "macos" | "linux";
  lastSeenAt: string | null;
  bridgeProtocolVersion: number | null;
  homeEnabled: boolean;
  homeRuntimePhase: HomeRuntimePhase | null;
  homeRuntimeProgress: number | null;
}

export type DesktopStatus = "online" | "offline" | "update_required";

export function desktopStatus(d: DesktopPresence, now: Date): DesktopStatus {
  if (!d.lastSeenAt || now.getTime() - Date.parse(d.lastSeenAt) > DESKTOP_OFFLINE_AFTER_MS)
    return "offline";
  return (d.bridgeProtocolVersion ?? 0) < MIN_DESKTOP_BRIDGE_PROTOCOL
    ? "update_required"
    : "online";
}

export interface HomeOnboarding {
  state: HomeSetupState;
  /** Computers online right now, ready to host ELISE Home. */
  online: DesktopPresence[];
  /** The one to continue on: the only online computer, or the one already preparing Home. */
  host: DesktopPresence | null;
  /** More than one online and none chosen yet: ask "¿En qué computadora…?". */
  choose: boolean;
}

/**
 * Where setup stands. Once a hub exists, its own presence decides (ADR-080); before that, the
 * person's Desktop installations do: none, offline, too old, or online (maybe preparing Home).
 */
export function homeOnboarding(
  hubSetup: HomeSetupState | null,
  desktops: readonly DesktopPresence[],
  now: Date,
): HomeOnboarding {
  const online = desktops.filter((d) => desktopStatus(d, now) === "online");
  const preparing = online.find((d) => d.homeEnabled) ?? null;
  const host = preparing ?? (online.length === 1 ? online[0]! : null);
  const base = { online, host, choose: !host && online.length > 1 };
  // The hub went quiet but this person's ELISE Desktop is open: it's reconnecting ELISE Home,
  // not "sin conexión" (which would send them to reopen an app that's already running).
  if (hubSetup === "desktop_offline" && online.length)
    return { ...base, state: "hub_initializing" };
  if (hubSetup) return { ...base, state: hubSetup };
  if (online.length) return { ...base, state: "desktop_online" };
  if (desktops.some((d) => desktopStatus(d, now) === "update_required"))
    return { ...base, state: "desktop_update_required" };
  if (desktops.length) return { ...base, state: "desktop_offline" };
  return { ...base, state: "desktop_not_configured" };
}
