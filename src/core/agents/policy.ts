import type { ActionOrigin } from "./tools";
import type { ApprovalMode, OperationDefinition } from "../capabilities/types";

export type ApprovalReason =
  "destructive" | "external_communication" | "sensitive" | "user_rule" | "bulk_change";

export type PolicyDecision =
  | { kind: "execute" }
  | { kind: "require_approval"; reason: ApprovalReason }
  | { kind: "reject"; reason: "not_permitted" };

export interface PolicyInput {
  operation: OperationDefinition;
  origin: ActionOrigin;
  /** Explicit user rule for this operation, if any. Cannot relax hard policies. */
  ruleMode?: ApprovalMode;
  /** Permission granted to the connection for this capability. */
  permission: "understand" | "read" | "write";
}

/**
 * Deterministic approval policy (docs/architecture/15 §19-21, docs/engineering/17 §21-27).
 * The model can propose an action; only this function decides whether it may run.
 */
export function decidePolicy({
  operation,
  origin,
  ruleMode,
  permission,
}: PolicyInput): PolicyDecision {
  if (operation.kind !== "read" && permission !== "write")
    return { kind: "reject", reason: "not_permitted" };
  if (operation.kind === "read") return { kind: "execute" };

  // Hard policy: critical actions always need an explicit approval, whatever the rules say.
  if (operation.risk === "critical")
    return { kind: "require_approval", reason: reasonFor(operation) };

  // A user acting directly in the UI is the confirmation (the UI shows its own destructive dialog).
  if (origin === "user_ui") return { kind: "execute" };

  const mode = ruleMode ?? operation.defaultApproval;
  switch (mode) {
    case "allow_automatically":
      return { kind: "execute" };
    case "always_ask":
      return { kind: "require_approval", reason: ruleMode ? "user_rule" : reasonFor(operation) };
    case "ask_when_uncertain":
      // Plain reversible writes proceed; anything destructive or outward-facing initiated by
      // ELISE (not typed by the user in the UI) is treated as uncertain.
      return operation.kind === "write"
        ? { kind: "execute" }
        : { kind: "require_approval", reason: reasonFor(operation) };
  }
}

function reasonFor(operation: OperationDefinition): ApprovalReason {
  if (operation.kind === "external_communication") return "external_communication";
  if (operation.kind === "sensitive") return "sensitive";
  // A plain write only asks when a tool escalated it (e.g. archiving many emails at once).
  if (operation.kind === "write") return "bulk_change";
  return "destructive";
}
