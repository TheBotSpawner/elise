import type { ConnectionStatus } from "./types";

/**
 * How a connected account is doing, in product terms (Connections health). Derived from the
 * stored status, the capabilities the user turned on and whether the provider granted them.
 * The UI maps each value to plain language and one obvious remedy; OAuth details never show.
 */
export type ConnectionHealth =
  /** Working: every capability that is on has the access it needs. */
  | "connected"
  /** A capability is on but the provider never granted it (e.g. Gmail unchecked at consent). */
  | "permission_missing"
  /** The provider stopped accepting ELISE's access (revoked, expired, password change). */
  | "expired"
  /** The last call failed for a reason that may pass on its own. */
  | "needs_attention"
  /** The provider can't be used from this server right now (not configured, or disabled). */
  | "unavailable";

export function connectionHealth(input: {
  status: ConnectionStatus;
  providerAvailable: boolean;
  lastErrorCode: string | null;
  capabilities: readonly { enabled: boolean; granted: boolean }[];
}): ConnectionHealth {
  if (!input.providerAvailable || input.status === "disabled") return "unavailable";
  if (input.status === "needs_reauthorization") return "expired";
  if (input.status === "error" || input.status === "connecting") return "needs_attention";
  if (input.capabilities.some((c) => c.enabled && !c.granted)) return "permission_missing";
  if (input.lastErrorCode) return "needs_attention";
  return "connected";
}
