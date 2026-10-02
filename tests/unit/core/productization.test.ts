import { afterEach, describe, expect, it, vi } from "vitest";

import { parseFlagOverrides } from "@/config/flags";
import { connectionHealth } from "@/core/providers/health";
import { firstPromptKeys } from "@/features/onboarding/model";
import { errorText, getDictionary } from "@/lib/i18n";

describe("connection health", () => {
  const base = {
    status: "connected" as const,
    providerAvailable: true,
    lastErrorCode: null,
    capabilities: [{ enabled: true, granted: true }],
  };
  it("names the one thing to fix", () => {
    expect(connectionHealth(base)).toBe("connected");
    expect(connectionHealth({ ...base, status: "needs_reauthorization" })).toBe("expired");
    expect(connectionHealth({ ...base, capabilities: [{ enabled: true, granted: false }] })).toBe(
      "permission_missing",
    );
    // A product the user turned off doesn't need permission.
    expect(connectionHealth({ ...base, capabilities: [{ enabled: false, granted: false }] })).toBe(
      "connected",
    );
    expect(connectionHealth({ ...base, lastErrorCode: "TIMEOUT" })).toBe("needs_attention");
    expect(connectionHealth({ ...base, providerAvailable: false })).toBe("unavailable");
  });
});

describe("first prompts after onboarding", () => {
  it("builds on what was set up", () => {
    const none = { calendar: false, email: false, tasks: true, spacePreset: null, spaceName: null };
    expect(firstPromptKeys(none)).toEqual(["planDay", "firstTask"]);
    expect(firstPromptKeys({ ...none, calendar: true, spacePreset: "university" })).toEqual([
      "today",
      "subjectSection",
      "planDay",
    ]);
    expect(firstPromptKeys({ ...none, email: true, spacePreset: "work" })[0]).toBe("clientSection");
  });

  it("every prompt has copy in both languages", () => {
    for (const locale of ["es", "en"] as const)
      for (const key of [
        "today",
        "subjectSection",
        "clientSection",
        "importantEmail",
        "planDay",
        "firstTask",
      ] as const)
        expect(getDictionary(locale).onboarding.firstPrompts[key]).toBeTruthy();
  });
});

describe("feature flags", () => {
  it("parses global and per-workspace overrides, ignoring unknown flags", () => {
    expect(parseFlagOverrides("wakePhrase:off,research:on,nope:on,study:ws=a;b")).toEqual({
      wakePhrase: { kind: "off" },
      research: { kind: "on" },
      study: { kind: "workspaces", ids: new Set(["a", "b"]) },
    });
    expect(parseFlagOverrides(undefined)).toEqual({});
  });
});

describe("user-facing errors", () => {
  it("never mixes languages and never shows internal messages", () => {
    const es = getDictionary("es");
    const en = getDictionary("en");
    const e = { code: "NOT_FOUND", message: "Task not found" };
    expect(errorText(es, e)).toBe(es.errors.codes.NOT_FOUND);
    expect(errorText(en, e)).toBe("Task not found");
    expect(errorText(en, { code: "INTERNAL_ERROR", message: "db exploded" })).toBe(
      en.errors.codes.INTERNAL_ERROR,
    );
    expect(errorText(es, { code: "SOMETHING_NEW" })).toBe(es.errors.codes.INTERNAL_ERROR);
  });
});

describe("usage cost estimates", () => {
  it("prices tokens by model and units by operation; unknown models get none", async () => {
    const { estimateCost } = await import("@/infrastructure/observability/usage");
    const llm = estimateCost({
      operation: "llm",
      provider: "openai",
      model: "gpt-5-mini-2026-08-07",
      inputTokens: 1_000_000,
      cachedTokens: 500_000,
      outputTokens: 100_000,
    });
    expect(llm).toBeCloseTo(0.5 * 0.25 + 0.5 * 0.025 + 0.1 * 2, 6);
    expect(
      estimateCost({ operation: "web_search", provider: "tavily", units: 2, unit: "queries" }),
    ).toBeCloseTo(0.016, 6);
    expect(
      estimateCost({ operation: "llm", provider: "x", model: "mystery-1", inputTokens: 10 }),
    ).toBeNull();
  });

  it("records into the active scope and never throws", async () => {
    const { recordUsage, setUsageSink, withUsageScope } =
      await import("@/infrastructure/observability/usage");
    const rows: Record<string, unknown>[] = [];
    setUsageSink(async (row) => void rows.push(row));
    await withUsageScope({ workspaceId: "w1", userId: "u1", feature: "chat" }, async () => {
      recordUsage({ operation: "speech", provider: "openai", units: 42, unit: "characters" });
      await Promise.resolve();
    });
    recordUsage({ operation: "llm", provider: "openai" }); // no scope: logged only
    await new Promise((r) => setTimeout(r, 0));
    expect(rows).toEqual([
      expect.objectContaining({ workspace_id: "w1", feature: "chat", operation: "speech" }),
    ]);
    setUsageSink(null);
  });
});

describe("OAuth return paths", () => {
  it("only returns to Connections or Onboarding", async () => {
    const { safeReturnPath } = await import("@/application/connections-service");
    expect(safeReturnPath("/onboarding")).toBe("/onboarding");
    for (const bad of ["https://evil.com", "//evil.com", "/settings", null, 42])
      expect(safeReturnPath(bad)).toBe("/connections");
  }, 30_000);
});

describe("server env", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("drops a malformed optional value instead of failing everything", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "not a url");
    vi.stubEnv("WEB_SEARCH_PROVIDER", "bing");
    vi.stubEnv("AI_PROFILE_FAST", "gpt-6-luna:low");
    const { serverEnv, invalidEnvKeys } = await import("@/config/server-env");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(serverEnv().NEXT_PUBLIC_APP_URL).toBeUndefined();
    expect(serverEnv().WEB_SEARCH_PROVIDER).toBeUndefined();
    expect(serverEnv().AI_PROFILE_FAST).toBe("gpt-6-luna:low");
    expect(invalidEnvKeys().sort()).toEqual(["NEXT_PUBLIC_APP_URL", "WEB_SEARCH_PROVIDER"]);
  });
});
