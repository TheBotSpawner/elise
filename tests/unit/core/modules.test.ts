import { describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/application/auth-context";
import { gatherBrief } from "@/application/morning-brief-service";
import { executeToolCall } from "@/core/agents/executor";
import type { ProviderFactory } from "@/core/agents/tools";
import { CAPABILITY_KEYS } from "@/core/capabilities/registry";
import {
  availableModules,
  effectiveModules,
  moduleOfPath,
  NATIVE_MODULES,
  visibleModuleKeys,
} from "@/core/modules/registry";
import { morningBriefConfigSchema } from "@/core/schedules/schedule";
import { en } from "@/lib/i18n/dictionaries/en";
import { es } from "@/lib/i18n/dictionaries/es";

import { makeCtx, makePorts } from "../../fixtures/core-fakes";
import { FakeSupabase } from "../../fixtures/fake-supabase";

/** Mi ELISE (ADR-064, ADR-070): one registry, one visibility preference — never a capability. */

vi.mock("server-only", () => ({}));

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
      "home",
    ]);
    for (const k of keys)
      for (const t of [es, en]) {
        expect(t.capabilities[k]).toBeTruthy();
        expect(t.myEliseModules.descriptions[k]).toBeTruthy();
        expect(t.myEliseModules.intents[k]).toBeTruthy();
      }
    expect(moduleOfPath("/my-elise/habits/123")).toBe("habits");
    expect(moduleOfPath("/settings/shortcuts")).toBeNull();
  });

  it("never chose → defaults; a saved choice always wins; unknown keys are ignored", () => {
    // Hogar needs ELISE Desktop first: shown to existing people, not to someone who never chose.
    expect(visibleModuleKeys(effectiveModules(null))).toEqual(
      NATIVE_MODULES.filter((m) => m.defaultForNewUsers).map((m) => m.key),
    );
    const saved = effectiveModules({ finance: false, unknown: true });
    expect(saved.finance).toBe(false);
    expect(saved.tasks).toBe(true);
    expect(visibleModuleKeys(saved)).not.toContain("finance");
  });
});

describe("hiding is visibility only", () => {
  it("a hidden module's tools still answer (no gating anywhere)", async () => {
    const { ports, tasks } = makePorts();
    await tasks.create({ title: "Keep me" });
    const out = await executeToolCall(ports, makeCtx(), { name: "tasks.list", args: {} });
    expect(out.status).toBe("succeeded");
    expect(tasks.tasks.size).toBe(1);
  });

  it("the Morning Brief keeps reading what the schedule asks for", async () => {
    const { ports, tasks } = makePorts();
    await tasks.create({ title: "Send proposal", dueDate: "2026-09-29" });
    const ctx = makeCtx({ origin: "schedule", now: new Date("2026-09-29T10:30:00Z") });
    const { data } = await gatherBrief(
      ports,
      ctx,
      morningBriefConfigSchema.parse({ blocks: ["tasks"] }),
    );
    expect(data.tasks?.map((t) => t.title)).toEqual(["Send proposal"]);
  });

  it("“mostrá / ocultá” through typed, audited settings tools", async () => {
    const saved: Record<string, boolean> = {};
    const settings = {
      modules: async () => [],
      setModules: async (c: Record<string, boolean>) => void Object.assign(saved, c),
    };
    const { ports, log } = makePorts([]);
    ports.providers = {
      get: ((c: string) => (c === "settings" ? settings : undefined)) as ProviderFactory["get"],
    };
    const show = await executeToolCall(ports, makeCtx(), {
      name: "modules.show",
      args: { modules: ["goals"] },
    });
    expect(show.status).toBe("succeeded");
    const hide = await executeToolCall(ports, makeCtx(), {
      name: "modules.hide",
      args: { modules: ["finance"] },
    });
    expect(hide.status).toBe("succeeded");
    expect(saved).toEqual({ goals: true, finance: false });
    const bad = await executeToolCall(ports, makeCtx(), {
      name: "modules.hide",
      args: { modules: ["email"] },
    });
    expect(bad).toMatchObject({ status: "failed", error: { code: "VALIDATION_ERROR" } });
    expect(log.auditEvents).toContainEqual({ eventType: "modules.show", result: "success" });
    expect(ports.registry.available(new Set(CAPABILITY_KEYS)).map((t) => t.name)).toContain(
      "modules.list",
    );
  });
});

describe("modules service", () => {
  const auth = (db: FakeSupabase, userId = "user-a") =>
    ({ db, userId, workspaceId: "ws-a" }) as unknown as AuthContext;

  /** One row of each module's own data, to prove nothing ever touches it. */
  const DATA: Record<string, string> = {
    tasks: "tasks",
    habits: "habits",
    lists: "lists",
    goals: "goals",
    notes: "notes",
    finance: "finance_transactions",
    home: "home_devices",
  };

  it.each(availableModules().map((m) => m.key))(
    "%s: hide → gone from Mi ELISE, data intact; show → back exactly as it was",
    async (key) => {
      const { moduleVisibility, setModuleVisibility, visibleModules } =
        await import("@/application/modules-service");
      const db = new FakeSupabase();
      const row = { id: `${key}-1`, workspace_id: "ws-a", title: "Mine" };
      db.rows(DATA[key]!).push(row);
      const a = auth(db);

      await setModuleVisibility(a, { [key]: false }, "user_ui");
      expect((await moduleVisibility(a))[key as never]).toBe(false);
      expect(await visibleModules(a)).not.toContain(key);
      expect(db.rows(DATA[key]!)).toEqual([row]);

      await setModuleVisibility(a, { [key]: true }, "user_ui");
      expect(await visibleModules(a)).toContain(key);
      expect(db.rows(DATA[key]!)).toEqual([row]);
      // Hiding what was already hidden by default isn't a change, so it isn't audited.
      const shownByDefault = NATIVE_MODULES.find((m) => m.key === key)!.defaultForNewUsers;
      expect(db.rows("audit_events").map((e) => e.event_type)).toEqual(
        shownByDefault ? ["module.hidden", "module.shown"] : ["module.shown"],
      );
    },
  );

  it("persists per person, audits only real changes, refuses unknown modules", async () => {
    const { moduleVisibility, setModuleVisibility, chooseModules, hasChosenModules } =
      await import("@/application/modules-service");
    const db = new FakeSupabase();
    const a = auth(db);
    expect(await hasChosenModules(a)).toBe(false);
    await setModuleVisibility(a, { goals: false }, "user_ui");
    await setModuleVisibility(a, { goals: false }, "user_ui");
    expect(db.rows("audit_events")).toHaveLength(1);
    // Stored in the person's preferences: survives any reload, sign-in or device.
    expect(db.rows("user_preferences")).toMatchObject([
      { key: "my_elise.visibility", user_id: "user-a", value_json: { goals: false } },
    ]);
    expect(await hasChosenModules(a)).toBe(true);
    await expect(setModuleVisibility(a, { email: true }, "ai")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    // Another person in the same workspace is unaffected.
    const b = auth(db, "user-b");
    expect((await moduleVisibility(b)).goals).toBe(true);
    // Onboarding: exactly the chosen ones shown; choosing none is allowed.
    await chooseModules(b, ["notes", "bogus"]);
    expect(visibleModuleKeys(await moduleVisibility(b))).toEqual(["notes"]);
  });
});
