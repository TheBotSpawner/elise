/**
 * A Capability is something ELISE can do for the user (Tasks, Email, Calendar...),
 * independent of which provider implements it (docs/architecture/07-capability-provider-model.md).
 */
export type CapabilityKey =
  | "tasks"
  | "email"
  | "calendar"
  | "knowledge"
  | "habits"
  | "lists"
  | "goals"
  | "notes"
  | "finance"
  | "structured"
  | "history"
  | "settings"
  | "workspace"
  | "web_search"
  | "location"
  | "weather"
  | "contexts"
  | "study"
  | "shortcuts"
  | "voice"
  | "schedules"
  | "methods";

/** docs/architecture/15-tools-actions-approvals.md §9 */
export type OperationKind =
  "read" | "write" | "destructive" | "external_communication" | "sensitive";

export type RiskLevel = "low" | "medium" | "high" | "critical";

/** docs/architecture/08-connections-auth-permissions.md §14 */
export type ApprovalMode = "always_ask" | "ask_when_uncertain" | "allow_automatically";

export interface OperationDefinition {
  kind: OperationKind;
  risk: RiskLevel;
  defaultApproval: ApprovalMode;
}

export interface CapabilityDefinition {
  key: CapabilityKey;
  /** `available` once at least one provider implements it end to end. */
  status: "available" | "planned";
  /** Implemented by ELISE itself (no provider, no binding): always available, read-only tools. */
  internal?: boolean;
  operations: Readonly<Record<string, OperationDefinition>>;
}
