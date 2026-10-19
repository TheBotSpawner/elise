/**
 * The managed ELISE Home runtime (ADR-082): what the person's computer runs so ELISE can reach
 * the devices at home. Provider-independent — today an ELISE-managed Home Assistant Container on
 * WSL2 (Windows), tomorrow a dedicated ELISE Home Hub. The UI and the cloud only ever see these
 * phases, never VM/container commands.
 */
export const HOME_RUNTIME_PHASES = [
  "not_installed",
  "checking_requirements",
  "requirements_missing",
  "restart_required",
  "downloading",
  "verifying",
  "installing",
  "starting",
  "ready",
  "degraded",
  "stopped",
  "updating",
  "error",
] as const;
export type HomeRuntimePhase = (typeof HOME_RUNTIME_PHASES)[number];

/** Phases where work is under way: the screen shows progress, never a dead end. */
export const HOME_RUNTIME_BUSY: ReadonlySet<HomeRuntimePhase> = new Set([
  "checking_requirements",
  "downloading",
  "verifying",
  "installing",
  "starting",
  "updating",
]);

export const HOME_RUNTIME_ERRORS = [
  "HOME_RUNTIME_REQUIREMENT_MISSING",
  "HOME_RUNTIME_UNSUPPORTED_HOST",
  "HOME_RUNTIME_DISK_LOW",
  "HOME_RUNTIME_ELEVATION_DECLINED",
  "HOME_RUNTIME_DOWNLOAD_FAILED",
  "HOME_RUNTIME_VERIFY_FAILED",
  "HOME_RUNTIME_INSTALL_FAILED",
  "HOME_RUNTIME_START_FAILED",
  "HOME_RUNTIME_NETWORK_FAILED",
  "HOME_RUNTIME_BOOTSTRAP_FAILED",
] as const;
export type HomeRuntimeErrorCode = (typeof HOME_RUNTIME_ERRORS)[number];

export const HOME_RUNTIME_REQUIREMENTS = [
  "windows_version",
  "architecture",
  "memory",
  "disk",
  "virtualization",
  "wsl",
] as const;
export type HomeRuntimeRequirementKey = (typeof HOME_RUNTIME_REQUIREMENTS)[number];

export interface HomeRuntimeRequirement {
  key: HomeRuntimeRequirementKey;
  ok: boolean;
  /** How it gets fixed: ELISE enables it (admin + maybe a restart), or the person must act. */
  fix: "none" | "enable" | "person";
  /** Technical detail for "Ver detalles" only. */
  detail?: string;
}

/** Real stages; a percentage only when the total is actually known. */
export type HomeRuntimeStage =
  | "checking"
  | "enabling"
  | "downloading_base"
  | "verifying"
  | "installing"
  | "downloading_engine"
  | "configuring"
  | "starting"
  | "connecting"
  | "backing_up";

export interface HomeRuntimeProgress {
  stage: HomeRuntimeStage;
  receivedBytes?: number;
  totalBytes?: number;
}

export interface HomeRuntimeStatus {
  phase: HomeRuntimePhase;
  progress: HomeRuntimeProgress | null;
  /** The managed runtime release installed (not the engine's own version string). */
  version: string | null;
  error: { code: HomeRuntimeErrorCode; detail: string | null } | null;
  requirements: HomeRuntimeRequirement[] | null;
  provider: "wsl_container" | "external" | "unsupported";
  /** Home is on for this computer (the person chose "Configurar ELISE Home"). */
  enabled: boolean;
}

export const progressPercent = (p: HomeRuntimeProgress | null): number | null =>
  p?.totalBytes && p.receivedBytes !== undefined
    ? Math.min(100, Math.floor((p.receivedBytes / p.totalBytes) * 100))
    : null;

export const requirementsMet = (reqs: readonly HomeRuntimeRequirement[]) => reqs.every((r) => r.ok);

/**
 * After a crash or restart in the middle of provisioning: where to pick up. Downloads resume,
 * verification and installation run again (idempotent); nothing stays "Preparando…" forever.
 */
export function resumePhase(persisted: HomeRuntimePhase, installed: boolean): HomeRuntimePhase {
  switch (persisted) {
    case "checking_requirements":
    case "requirements_missing":
    case "restart_required":
      return "checking_requirements";
    case "downloading":
    case "verifying":
    case "installing":
      return "downloading";
    case "updating":
      return installed ? "starting" : "downloading";
    case "starting":
    case "ready":
    case "degraded":
      return installed ? "starting" : "not_installed";
    default:
      return persisted;
  }
}
