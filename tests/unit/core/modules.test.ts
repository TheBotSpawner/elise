import { describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { gatherBrief } from "@/application/morning-brief-service";
import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import { CAPABILITY_KEYS } from "@/core/capabilities/registry";
import {
  availableModules,
  disabledCapabilities,
  effectiveModules,
  enabledModuleKeys,
  type ModuleStates,
  moduleOfBriefBlock,
  moduleOfCapability,
  moduleOfPath,
  NATIVE_MODULES,
} from "@/core/modules/registry";
import { morningBriefConfigSchema } from "@/core/schedules/schedule";
import { en } from "@/lib/i18n/dictionaries/en";
import { es } from "@/lib/i18n/dictionaries/es";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";
import { FakeSupabase } from "../../fixtures/fake-supabase";

/** Mi ELISE (ADR-064): one registry, one preference, enforced in tools, briefs and plans. */

vi.mock("server-only", () => ({}));

const ALL_ON = effectiveModules([]);
const states = (off: string[]): ModuleStates =>
  Object.fromEntries(NATIVE_MODULES.map((m) => [m.key, !off.includes(m.key)])) as ModuleStates;

describe("native module registry", () => {
  it("declares each module once, with its own route, order and copy in both languages", () => {
    const keys = NATIVE_MODULES.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(NATIVE_MODULES.map((m) => m.route)).size).toBe(keys.length);
    expect(availableModules().map((m) => m.key)).toEqual([
      "tasks",
      "habits",
      "lists",
      "goals",
      "notes",
      "finance",
    ]);
    for (const k of keys)
      for (const t of [es, en]) {
        expect(t.capabilities[k]).toBeTruthy();
        expect(t.myEliseModules.descriptions[k]).toBeTruthy();
        expect(t.myEliseModules.intents[k]).toBeTruthy();
      }
  });

  it("maps capabilities, routes and brief blocks back to their module", () => {
    expect(moduleOfCapability("finance")).toBe("finance");
    expect(moduleOfCapability("email")).toBeNull();
    expect(moduleOfPath("/my-elise/habits/123")).toBe("habits");
    expect(moduleOfPath("/settings/shortcuts")).toBeNull();
    expect(moduleOfBriefBlock("tasks")).toBe("tasks");
    expect(moduleOfBriefBlock("email")).toBeNull();
  });

  it("existing users keep what they had; a saved choice always wins", () => {
    // No rows: never chose — the new-user defaults.
    expect(enabledModuleKeys(ALL_ON)).toHaveLength(NATIVE_MODULES.length);
    const saved = effectiveModules([
      { module_key: "finance", enabled: false },
      { module_key: "unknown", enabled: true },
    ]);
    expect(saved.finance).toBe(false);
    expect(saved.tasks).toBe(true);
    expect(disabledCapabilities(saved)).toEqual(new Set(["finance"]));
  });
});

describe("tool gating", () => {
  it("refuses a disabled module's tools with module_disabled and keeps the data", async () => {
    const { ports, tasks } = makePorts();
    await tasks.create({ title: "Keep me" });
    ports.moduleStates = async () => states(["tasks"]);
    const out = await executeToolCall(ports, makeCtx(), { name: "tasks.list", args: {} });
    expect(out).toMatchObject({
      status: "failed",
      error: { code: "CAPABILITY_UNAVAILABLE" },
      moduleDisabled: "tasks",
    });
    expect(out.status === "failed" && out.error.message).toContain("modules.enable");
    expect(tasks.tasks.size).toBe(1);
  });

  it("leaves enabled modules and non-module capabilities alone", async () => {
    const { ports } = makePorts();
    ports.moduleStates = async () => states(["finance"]);
    const out = await executeToolCall(ports, makeCtx(), { name: "tasks.list", args: {} });
    expect(out.status).toBe("succeeded");
  });

  it("turns modules on and off through typed, audited settings tools", async () => {
    const saved: Record<string, boolean> = {};
    const settings = {
      modules: async () => [],
      setModules: async (c: Record<string, boolean>) => void Object.assign(saved, c),
    };
    const { ports, log } = makePorts([]);
    ports.providers = {
      get: ((c: string) => (c === "settings" ? settings : undefined)) as ProviderFactory["get"],
    };
    const on = await executeToolCall(ports, makeCtx(), {
      name: "modules.enable",
      args: { modules: ["habits"] },
    });
    expect(on.status).toBe("succeeded");
    expect(saved).toEqual({ habits: true });
    const bad = await executeToolCall(ports, makeCtx(), {
      name: "modules.disable",
      args: { modules: ["email"] },
    });
    expect(bad).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    expect(log.auditEvents).toContainEqual({ eventType: "modules.enable", result: "success" });
    // The settings tools themselves are never gated by a module.
    expect(ports.registry.available(new Set(CAPABILITY_KEYS)).map((t) => t.name)).toContain(
      "modules.list",
    );
  });
});

describe("schedules and orchestrations", () => {
  it("Morning Brief skips a disabled block quietly, and brings it back when re-enabled", async () => {
    const { ports, tasks } = makePorts();
    await tasks.create({ title: "Send proposal", dueDate: "2026-09-29" });
    const ctx = makeCtx({ origin: "schedule", now: new Date("2026-09-29T10:30:00Z") });
    const config = morningBriefConfigSchema.parse({ blocks: ["tasks"] });

    ports.moduleStates = async () => states(["tasks"]);
    const off = await gatherBrief(ports, ctx, config);
    expect(off.skipped).toEqual([{ block: "tasks", reason: "module_disabled" }]);
    expect(off.data.warnings).toEqual([]);
    expect(off.failed).toBe(0);
    expect(off.data.tasks ?? []).toEqual([]);

    ports.moduleStates = async () => ALL_ON;
    const on = await gatherBrief(ports, ctx, config);
    expect(on.skipped).toEqual([]);
    expect(on.data.tasks?.map((t) => t.title)).toEqual(["Send proposal"]);
  });

  it("planning.today leaves a disabled module out instead of calling it unavailable", async () => {
    const { ports } = makePorts();
    ports.moduleStates = async () => states(["tasks", "habits", "goals"]);
    const out = await executeToolCall(ports, makeCtx(), { name: "planning.today", args: {} });
    expect(out.status).toBe("succeeded");
    const unavailable =
      (out.status === "succeeded" && (out.output as { unavailable?: string[] }).unavailable) || [];
    // Calendar has no connection here: a real gap, still named.
    expect(unavailable.some((u) => u.startsWith("calendar"))).toBe(true);
    expect(unavailable.filter((u) => /tasks|habits|goals/.test(u))).toEqual([]);
  });
});

describe("modules service", () => {
  const auth = (db: FakeSupabase) =>
    ({ db, userId: "user-a", workspaceId: "ws-a" }) as unknown as AuthContext;

  it("saves a choice per person, audits only real changes, and never touches other data", async () => {
    const { moduleStates, setModules, chooseModules } =
      await import("@/application/modules-service");
    const db = new FakeSupabase();
    db.rows("tasks").push({ id: "t1", workspace_id: "ws-a", title: "Keep me" });
    const a = auth(db);

    await setModules(a, { finance: false }, "user_ui");
    expect((await moduleStates(a)).finance).toBe(false);
    await setModules(a, { finance: false }, "user_ui");
    expect(db.rows("audit_events").map((e) => e.event_type)).toEqual(["module.disabled"]);
    expect(db.rows("tasks")).toHaveLength(1);

    await expect(setModules(a, { email: true }, "ai")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    // Another person in the same workspace is unaffected.
    const b = { ...a, userId: "user-b" } as AuthContext;
    expect((await moduleStates(b)).finance).toBe(true);

    // Onboarding: exactly the chosen ones; choosing none is allowed.
    await chooseModules(b, []);
    expect(enabledModuleKeys(await moduleStates(b))).toEqual([]);
    await chooseModules(b, ["notes", "bogus"]);
    expect(enabledModuleKeys(await moduleStates(b))).toEqual(["notes"]);
  });
});
