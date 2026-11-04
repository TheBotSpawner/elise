import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { budgetMode, modalityOf, warnLevel } from "@/core/budget/policy";
import {
  assertSpendCleared,
  assess,
  estimateCost,
  recordUsage,
  setUsageSink,
  withUsageScope,
} from "@/infrastructure/observability/usage";

vi.mock("@/infrastructure/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: null, error: null }),
  }),
}));

type Gate = import("@/application/budget-service").Gate;

const { clearSpend, setBudgetGate, withBackgroundSpend, withSpend } =
  await import("@/application/budget-service");

const scope = { workspaceId: "ws-1", userId: "user-1", feature: "chat" };
const deny = async () => ({ reservation_id: "r", allowed: false, reason: "month_limit" });
const allow = async () => ({ reservation_id: "r", allowed: true, reason: null });

afterEach(() => {
  vi.unstubAllEnvs();
  setBudgetGate(null);
  setUsageSink(null);
});

describe("the mode", () => {
  it("never enforces by accident", () => {
    expect(budgetMode(undefined, "a")).toBe("observe");
    expect(budgetMode("enforce", "a")).toBe("observe");
    expect(budgetMode("ENFORCED", "a")).toBe("observe");
    expect(budgetMode("enforced", "a")).toBe("enforced");
    expect(budgetMode("shadow", "a")).toBe("shadow");
  });

  it("can enforce only on chosen workspaces", () => {
    expect(budgetMode("enforced:ws=a;b", "b")).toBe("enforced");
    expect(budgetMode("enforced:ws=a;b", "c")).toBe("shadow");
    expect(budgetMode("enforced:ws=a;b", null)).toBe("shadow");
  });
});

describe("the gate", () => {
  it("observe doesn't even ask", async () => {
    const gate = vi.fn(deny);
    setBudgetGate(gate);
    const spend = await clearSpend(scope);
    expect(gate).not.toHaveBeenCalled();
    expect(spend.scope.cleared).toBe(true);
  });

  it("shadow asks and lets it through, without holding anything", async () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "shadow");
    const gate = vi.fn(deny);
    setBudgetGate(gate);
    const spend = await clearSpend(scope);
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ enforce: false }));
    expect(spend.scope.cleared).toBe(true);
  });

  it("shadow survives a gate that fails, without waiting for it", async () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "shadow");
    setBudgetGate(() => Promise.reject(new Error("down")));
    await expect(clearSpend(scope)).resolves.toMatchObject({ scope: { cleared: true } });
  });

  it("enforced refuses, and says nothing about money", async () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "enforced");
    setBudgetGate(deny);
    const error = await clearSpend(scope).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
    expect((error as Error).message).not.toMatch(/\$|usd|micro|cost/i);
  });

  it("a gate that fails never means unlimited", async () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "enforced");
    setBudgetGate(() => Promise.reject(new Error("down")));
    await expect(clearSpend(scope)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("degraded allows a little plain chat, and no voice", async () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "enforced");
    vi.stubEnv("ELISE_BUDGET_ON_ERROR", "degraded");
    setBudgetGate(() => Promise.reject(new Error("down")));
    const who = { ...scope, userId: `degraded-${crypto.randomUUID()}` };
    for (let i = 0; i < 5; i++) await expect(clearSpend(who)).resolves.toBeDefined();
    await expect(clearSpend(who)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(clearSpend({ ...who, feature: "voice" })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
  });

  it("a sentence of voice doesn't ask again within the lease", async () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "enforced");
    const gate = vi.fn(allow);
    setBudgetGate(gate);
    const voice = { ...scope, feature: "voice" };
    await clearSpend(voice);
    await clearSpend(voice);
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("uses the identity it's given and the same key on a retry", async () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "enforced");
    const gate = vi.fn<Gate>(allow);
    setBudgetGate(gate);
    await clearSpend(scope, "turn:1");
    await clearSpend(scope, "turn:1");
    expect(gate.mock.calls.map(([a]) => a.key)).toEqual(["turn:1", "turn:1"]);
    expect(gate.mock.calls[0]![0]).toMatchObject({ user: "user-1", workspace: "ws-1" });
  });
});

describe("the adapters' safety net", () => {
  it("does nothing while observing", () => {
    expect(() => assertSpendCleared("llm")).not.toThrow();
  });

  it("refuses a path nobody wired through the gate", () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "enforced");
    expect(() => assertSpendCleared("llm")).toThrow();
    expect(() => withUsageScope(scope, () => assertSpendCleared("speech"))).toThrow();
  });

  it("only logs it in shadow", () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "shadow");
    expect(() => assertSpendCleared("llm")).not.toThrow();
  });

  it("lets a cleared scope spend", async () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "enforced");
    setBudgetGate(allow);
    await expect(withSpend(scope, async () => assertSpendCleared("llm"))).resolves.toBeUndefined();
  });

  it("a refused job still runs, but can't spend", async () => {
    vi.stubEnv("ELISE_BUDGET_MODE", "enforced");
    setBudgetGate(deny);
    const ran = vi.fn(async () => assertSpendCleared("llm"));
    const job = { workspaceId: "ws-1", feature: "schedule", source: "job" as const };
    await expect(withBackgroundSpend(job, ran)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(ran).toHaveBeenCalled();
  });
});

describe("what a call costs", () => {
  const micro = (r: Parameters<typeof assess>[0]) => assess(r).budgetMicro;

  it("prices the default model, with its cache", () => {
    expect(
      estimateCost({
        operation: "llm",
        provider: "openai",
        model: "gpt-6-luna",
        inputTokens: 200_000,
        cachedTokens: 100_000,
        cacheWriteTokens: 20_000,
        outputTokens: 20_000,
      }),
    ).toBeCloseTo(0.008 + 0.001 + 0.0025 + 0.01, 6);
  });

  it("charges the long-context rate above the threshold", () => {
    expect(
      estimateCost({
        operation: "llm",
        provider: "openai",
        model: "gpt-6-luna",
        inputTokens: 300_000,
        outputTokens: 0,
      }),
    ).toBeCloseTo(0.06, 6);
  });

  it("adds a hosted search's fee to its tokens", () => {
    expect(
      estimateCost({
        operation: "web_search",
        provider: "openai",
        model: "gpt-4.1-mini",
        inputTokens: 8_000,
        outputTokens: 0,
        units: 1,
        unit: "queries",
      }),
    ).toBeCloseTo(0.0032 + 0.01, 6);
  });

  it("prices ElevenLabs per the model that really spoke", () => {
    expect(
      micro({
        operation: "speech",
        provider: "elevenlabs",
        model: "eleven_flash_v2_5",
        units: 1000,
        unit: "characters",
      }),
    ).toBe(40_000);
  });

  it("doesn't invent a price, but an unknown cost is never free", () => {
    const r = assess({
      operation: "speech",
      provider: "openai",
      model: "gpt-4o-mini-tts",
      units: 100,
      unit: "characters",
    });
    expect(r).toMatchObject({ cost: null, costStatus: "unknown" });
    expect(r.budgetMicro).toBeGreaterThan(0);
  });

  it("a failed call wasn't billed; a cut stream is an estimate", () => {
    expect(assess({ operation: "llm", provider: "openai", status: "failed" })).toMatchObject({
      budgetMicro: 0,
    });
    expect(
      assess({
        operation: "llm",
        provider: "openai",
        model: "gpt-6-luna",
        inputTokens: 1000,
        outputTokens: 10,
        status: "cancelled",
      }).costStatus,
    ).toBe("estimated");
  });

  it("is integer micro-USD, rounded up", () => {
    const m = micro({
      operation: "embedding",
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: 1,
    });
    expect(m).toBe(1);
    expect(Number.isInteger(m)).toBe(true);
  });
});

describe("what an event keeps", () => {
  let rows: Record<string, unknown>[];
  beforeEach(() => {
    rows = [];
    setUsageSink(async (row) => void rows.push(row));
  });

  it("is metadata: no text of any kind, and a key that dedupes retries", async () => {
    withUsageScope({ ...scope, source: "desktop", cleared: true }, () =>
      recordUsage({
        operation: "llm",
        provider: "openai",
        model: "gpt-6-luna",
        inputTokens: 10,
        outputTokens: 2,
        providerRequestId: "resp_1",
      }),
    );
    await vi.waitFor(() => expect(rows).toHaveLength(1));
    expect(rows[0]).toMatchObject({
      workspace_id: "ws-1",
      user_id: "user-1",
      source: "desktop",
      modality: "chat",
      idempotency_key: "openai:resp_1",
      cost_status: "actual",
    });
    expect(Object.keys(rows[0]!).sort()).toMatchInlineSnapshot(`
      [
        "ai_run_id",
        "budget_micro",
        "cache_write_tokens",
        "cached_tokens",
        "cost_status",
        "estimated_cost_usd",
        "feature",
        "idempotency_key",
        "input_tokens",
        "latency_ms",
        "modality",
        "model",
        "operation",
        "output_tokens",
        "price_version",
        "provider",
        "provider_request_id",
        "reasoning_tokens",
        "reservation_id",
        "source",
        "status",
        "unit",
        "units",
        "user_id",
        "workspace_id",
      ]
    `);
  });
});

describe("what a person is told", () => {
  it("is a level, at the configured thresholds", () => {
    expect([0, 69, 70, 89, 90, 99, 100, 140].map(warnLevel)).toEqual([
      null,
      null,
      70,
      70,
      90,
      90,
      100,
      100,
    ]);
  });

  it("voice turns and calls count as voice, anything else not chat as background", () => {
    expect(["voice", "voice_turn", "chat", "schedule"].map(modalityOf)).toEqual([
      "voice",
      "voice",
      "chat",
      "background",
    ]);
  });
});
