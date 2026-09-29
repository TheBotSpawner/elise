import type { CapabilityBinding, ContextType, ProviderKey } from "./types";
import type { CapabilityKey, OperationKind } from "../capabilities/types";

export interface ResolutionRequest {
  capability: CapabilityKey;
  operationKind: OperationKind;
  /** Explicit selection by id (UI choice, or the connection an existing item lives in). */
  connectionId?: string | null;
  /** Restrict to one provider (e.g. an existing ELISE Native item). */
  providerKey?: ProviderKey | null;
  /** Account named in natural language: "Firbot", "Google", "ELISE", an email… */
  destination?: string | null;
  context?: { type: ContextType; id?: string | null } | null;
}

export type ResolutionReason =
  | "explicit"
  | "destination"
  | "context_default"
  | "context_match"
  | "global_default"
  | "only_option"
  | "multi_read";

export type Resolution =
  | { kind: "resolved"; bindings: CapabilityBinding[]; reason: ResolutionReason }
  | { kind: "clarify"; candidates: CapabilityBinding[] }
  | {
      kind: "unavailable";
      reason:
        "no_binding" | "connection_unhealthy" | "connection_not_found" | "destination_not_found";
    };

const PROVIDER_NAMES: Record<ProviderKey, string[]> = {
  elise_native: ["elise"],
  google: ["google"],
  notion: ["notion"],
  web_search: ["web"],
};

/**
 * Deterministic provider resolution (docs/architecture/07 §21):
 * explicit → named destination → context → context default → global default → safe
 * multi-read → ask. Principle: read broadly when safe, write narrowly when certain.
 */
export function resolveBindings(
  all: readonly CapabilityBinding[],
  req: ResolutionRequest,
): Resolution {
  const forCapability = all.filter(
    (b) =>
      b.capability === req.capability &&
      b.enabled &&
      (!req.providerKey || b.providerKey === req.providerKey),
  );
  if (forCapability.length === 0) {
    return {
      kind: "unavailable",
      reason: req.connectionId ? "connection_not_found" : "no_binding",
    };
  }

  if (req.connectionId) {
    const explicit = forCapability.find((b) => b.connectionId === req.connectionId);
    // Never silently fall back to another account when a specific one was named.
    if (!explicit) return { kind: "unavailable", reason: "connection_not_found" };
    if (explicit.connectionStatus !== "connected")
      return { kind: "unavailable", reason: "connection_unhealthy" };
    return { kind: "resolved", bindings: [explicit], reason: "explicit" };
  }

  let pool = forCapability;
  let named = false;
  if (req.destination && req.destination.trim()) {
    // The most specific match wins: "Google Personal" beats every other Google account.
    const scored = forCapability.map((b) => ({ b, score: destinationScore(b, req.destination!) }));
    const best = Math.max(...scored.map((x) => x.score));
    if (best === 0) return { kind: "unavailable", reason: "destination_not_found" };
    pool = scored.filter((x) => x.score === best).map((x) => x.b);
    named = true;
  }

  const usable = pool.filter((b) => b.connectionStatus === "connected");
  if (usable.length === 0) return { kind: "unavailable", reason: "connection_unhealthy" };

  if (named) {
    const connections = uniqueByConnection(usable);
    if (req.operationKind === "read" || connections.length === 1) {
      return { kind: "resolved", bindings: connections, reason: "destination" };
    }
    const preferred = usable.find((b) => b.isDefault);
    if (preferred) return { kind: "resolved", bindings: [preferred], reason: "destination" };
    return { kind: "clarify", candidates: connections };
  }

  const ctx = req.context;
  const inContext = ctx
    ? usable.filter(
        (b) =>
          b.contextType === ctx.type && (b.contextId === null || b.contextId === (ctx.id ?? null)),
      )
    : [];

  if (req.operationKind === "read") {
    if (inContext.length > 0) {
      return { kind: "resolved", bindings: uniqueByConnection(inContext), reason: "context_match" };
    }
    const connections = uniqueByConnection(usable);
    return {
      kind: "resolved",
      bindings: connections,
      reason: connections.length === 1 ? "only_option" : "multi_read",
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

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * How well a named destination refers to a binding: one point per matching name among its
 * alias, account, context and provider. 0 = no match.
 */
export function destinationScore(binding: CapabilityBinding, destination: string): number {
  const wanted = normalize(destination);
  if (wanted.length < 2) return 0;
  const names = [
    binding.label,
    binding.accountLabel,
    binding.contextLabel,
    ...PROVIDER_NAMES[binding.providerKey],
  ]
    .filter((n): n is string => Boolean(n))
    .map(normalize)
    .filter((n) => n.length >= 2);
  const words = wanted.split(/[^a-z0-9@._-]+/).filter((w) => w.length >= 2);
  return new Set(
    names.filter((name) => name === wanted || words.includes(name) || name.includes(wanted)),
  ).size;
}

function uniqueByConnection(bindings: readonly CapabilityBinding[]): CapabilityBinding[] {
  const seen = new Map<string, CapabilityBinding>();
  const ordered = [...bindings].sort(
    (a, z) => Number(z.isDefault) - Number(a.isDefault) || z.priority - a.priority,
  );
  for (const b of ordered) {
    if (!seen.has(b.connectionId)) seen.set(b.connectionId, b);
  }
  return [...seen.values()];
}
