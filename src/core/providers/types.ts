import type { CapabilityKey } from "../capabilities/types";

export type ProviderKey =
  "elise_native" | "google" | "notion" | "web_search" | "spotify" | "youtube" | "deezer";

export interface ProviderDefinition {
  key: ProviderKey;
  authType: "none" | "oauth2" | "api_key";
  supportsMultipleAccounts: boolean;
  capabilities: readonly CapabilityKey[];
  /** `available` = can be connected/used today. */
  status: "available" | "planned";
  /** Who owns the data for the capabilities this provider implements. */
  sourceOfTruth: "elise" | "external";
}

export type ConnectionStatus =
  "connecting" | "connected" | "needs_reauthorization" | "error" | "disabled" | "disconnected";

/** A concrete account authorized in a workspace (never contains credentials). */
export interface Connection {
  id: string;
  workspaceId: string;
  providerKey: ProviderKey;
  displayName: string;
  accountLabel: string | null;
  status: ConnectionStatus;
}

export type ContextType = "personal" | "work" | "entity" | "knowledge_space" | "custom";

/** Capability + connection + optional context (docs/architecture/07 §8). */
export interface CapabilityBinding {
  id: string;
  capability: CapabilityKey;
  connectionId: string;
  providerKey: ProviderKey;
  connectionStatus: ConnectionStatus;
  contextType: ContextType | null;
  contextId: string | null;
  priority: number;
  isDefault: boolean;
  enabled: boolean;
  /** User-facing name of the connection ("Personal", "Acme", "ELISE"). */
  label: string;
  /** Account identity at the provider (e.g. the Google email). Never a secret. */
  accountLabel: string | null;
  /** Free-text context the user attached to the connection ("Acme", "Client A"). */
  contextLabel: string | null;
}
