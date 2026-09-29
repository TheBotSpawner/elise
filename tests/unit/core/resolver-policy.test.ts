import { describe, expect, it } from "vitest";

import { decidePolicy } from "@/core/agents/policy";
import { getOperation } from "@/core/capabilities/registry";
import { resolveBindings } from "@/core/providers/resolver";
import type { CapabilityBinding } from "@/core/providers/types";

const binding = (over: Partial<CapabilityBinding>): CapabilityBinding => ({
  id: crypto.randomUUID(),
  capability: "tasks",
  connectionId: crypto.randomUUID(),
  providerKey: "elise_native",
  connectionStatus: "connected",
  contextType: null,
  contextId: null,
  priority: 100,
  isDefault: false,
  enabled: true,
  label: "Account",
  accountLabel: null,
  contextLabel: null,
  ...over,
});

describe("resolveBindings", () => {
  const native = binding({ isDefault: true });
  const google = binding({ providerKey: "google", contextType: "work" });

  it("is unavailable when nothing is bound or every connection is unhealthy", () => {
    expect(resolveBindings([], { capability: "tasks", operationKind: "read" })).toEqual({
      kind: "unavailable",
      reason: "no_binding",
    });
    expect(
      resolveBindings([binding({ connectionStatus: "needs_reauthorization" })], {
        capability: "tasks",
        operationKind: "write",
      }),
    ).toEqual({ kind: "unavailable", reason: "connection_unhealthy" });
  });

  it("reads broadly across accounts when no context is given", () => {
    const r = resolveBindings([native, google], { capability: "tasks", operationKind: "read" });
    expect(r).toMatchObject({ kind: "resolved", reason: "multi_read" });
    expect(r.kind === "resolved" && r.bindings).toHaveLength(2);
  });

  it("writes narrowly: context first, then global default", () => {
    expect(
      resolveBindings([native, google], {
        capability: "tasks",
        operationKind: "write",
        context: { type: "work" },
      }),
    ).toMatchObject({ kind: "resolved", reason: "context_match", bindings: [google] });
    expect(
      resolveBindings([native, google], { capability: "tasks", operationKind: "write" }),
    ).toMatchObject({
      kind: "resolved",
      reason: "global_default",
      bindings: [native],
    });
  });

  it("asks which account when a write has several candidates and no default", () => {
    const a = binding({ providerKey: "google" });
    const b = binding({ providerKey: "google" });
    expect(resolveBindings([a, b], { capability: "tasks", operationKind: "write" })).toMatchObject({
      kind: "clarify",
    });
  });

  it("never falls back to another account when the user named one", () => {
    expect(
      resolveBindings([native], {
        capability: "tasks",
        operationKind: "write",
        connectionId: "missing",
      }),
    ).toEqual({ kind: "unavailable", reason: "connection_not_found" });
  });
});

describe("decidePolicy", () => {
  const op = (name: string) => getOperation("tasks", name)!;

  it("runs reads and simple writes automatically", () => {
    expect(decidePolicy({ operation: op("list"), origin: "ai", permission: "read" })).toEqual({
      kind: "execute",
    });
    expect(decidePolicy({ operation: op("create"), origin: "ai", permission: "write" })).toEqual({
      kind: "execute",
    });
  });

  it("asks before ELISE deletes, but not when the user deletes from the UI", () => {
    expect(decidePolicy({ operation: op("delete"), origin: "ai", permission: "write" })).toEqual({
      kind: "require_approval",
      reason: "destructive",
    });
    expect(
      decidePolicy({ operation: op("delete"), origin: "schedule", permission: "write" }),
    ).toMatchObject({
      kind: "require_approval",
    });
    expect(
      decidePolicy({ operation: op("delete"), origin: "user_ui", permission: "write" }),
    ).toEqual({
      kind: "execute",
    });
  });

  it("honors explicit rules and rejects writes without write permission", () => {
    expect(
      decidePolicy({
        operation: op("create"),
        origin: "ai",
        permission: "write",
        ruleMode: "always_ask",
      }),
    ).toEqual({ kind: "require_approval", reason: "user_rule" });
    expect(
      decidePolicy({ operation: op("create"), origin: "user_ui", permission: "read" }),
    ).toEqual({
      kind: "reject",
      reason: "not_permitted",
    });
  });

  it("never lets a rule auto-approve critical operations", () => {
    expect(
      decidePolicy({
        operation: { kind: "sensitive", risk: "critical", defaultApproval: "always_ask" },
        origin: "user_ui",
        permission: "write",
        ruleMode: "allow_automatically",
      }),
    ).toMatchObject({ kind: "require_approval" });
  });
});
