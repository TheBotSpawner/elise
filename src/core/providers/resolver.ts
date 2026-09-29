import type { CapabilityBinding, ContextType } from "./types";
import type { CapabilityKey, OperationKind } from "../capabilities/types";

export interface ResolutionRequest {
  capability: CapabilityKey;
  operationKind: OperationKind;
  /** Explicit user selection always wins. */
  connectionId?: string | null;
  context?: { type: ContextType; id?: string | null } | null;
}

export type ResolutionReason =
  | "explicit"
  | "context_default"
  | "context_match"
  | "global_default"
  | "only_option"
  | "multi_read";

export type Resolution =
  | { kind: "resolved"; bindings: CapabilityBinding[]; reason: ResolutionReason }
  | { kind: "clarify"; candidates: CapabilityBinding[] }
  | { kind: "unavailable"; reason: "no_binding" | "connection_unhealthy" | "connection_not_found" };

/**
 * Deterministic provider resolution (docs/architecture/07 §21):
 * explicit → context → context default → global default → safe multi-read → ask.
 * Principle: read broadly when safe, write narrowly when certain.
 */
export function resolveBindings(
  all: readonly CapabilityBinding[],
  req: ResolutionRequest,
): Resolution {
  const forCapability = all.filter((b) => b.capability === req.capability && b.enabled);
  if (forCapability.length === 0) return { kind: "unavailable", reason: "no_binding" };

  const usable = forCapability.filter((b) => b.connectionStatus === "connected");
  if (usable.length === 0) return { kind: "unavailable", reason: "connection_unhealthy" };

  if (req.connectionId) {
    const explicit = usable.find((b) => b.connectionId === req.connectionId);
    if (explicit) return { kind: "resolved", bindings: [explicit], reason: "explicit" };
    // Never silently fall back to another account when the user named one.
    return { kind: "unavailable", reason: "connection_not_found" };
  }

  const ctx = req.context;
  const inContext = ctx
    ? usable.filter(
        (b) =>
          b.contextType === ctx.type && (b.contextId === null || b.contextId === (ctx.id ?? null)),
      )
    : [];

  if (req.operationKind === "read") {
    if (inContext.length > 0)
      return { kind: "resolved", bindings: uniqueByConnection(inContext), reason: "context_match" };
    return {
      kind: "resolved",
      bindings: uniqueByConnection(usable),
      reason: usable.length === 1 ? "only_option" : "multi_read",
    };
  }

  const contextDefault = inContext.find((b) => b.isDefault);
  if (contextDefault)
    return { kind: "resolved", bindings: [contextDefault], reason: "context_default" };
  if (uniqueByConnection(inContext).length === 1) {
    return { kind: "resolved", bindings: [inContext[0]!], reason: "context_match" };
  }

  const globalDefault = usable.find((b) => b.isDefault && b.contextType === null);
  if (globalDefault)
    return { kind: "resolved", bindings: [globalDefault], reason: "global_default" };

  const candidates = uniqueByConnection(usable);
  if (candidates.length === 1)
    return { kind: "resolved", bindings: candidates, reason: "only_option" };
  return { kind: "clarify", candidates };
}

function uniqueByConnection(bindings: readonly CapabilityBinding[]): CapabilityBinding[] {
  const seen = new Map<string, CapabilityBinding>();
  for (const b of [...bindings].sort((a, z) => z.priority - a.priority)) {
    if (!seen.has(b.connectionId)) seen.set(b.connectionId, b);
  }
  return [...seen.values()];
}
