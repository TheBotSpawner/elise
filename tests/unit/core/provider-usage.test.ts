import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIProvider } from "@/infrastructure/ai/openai/provider";
import { DEFAULT_PROFILES } from "@/infrastructure/ai/profiles";
import { setUsageSink, withUsageScope } from "@/infrastructure/observability/usage";

/** ADR-138: one model call, one event, however it ends. */

type Ev = { type: string; [k: string]: unknown };

const completed = {
  type: "response.completed",
  response: {
    id: "resp_1",
    model: "gpt-6-luna",
    usage: {
      input_tokens: 1000,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  },
};

const client = (events: (signal: AbortSignal) => AsyncGenerator<Ev>) => ({
  responses: { create: async (_b: unknown, o: { signal: AbortSignal }) => events(o.signal) },
});

async function run(fake: ReturnType<typeof client>, signal?: AbortSignal) {
  const rows: Record<string, unknown>[] = [];
  setUsageSink(async (row) => void rows.push(row));
  const provider = OpenAIProvider.withClient(
    { apiKey: "k", profiles: DEFAULT_PROFILES, firstOutputMs: 20 },
    fake as never,
  );
  const scope = { workspaceId: "ws", userId: "u", feature: "chat" };
  await withUsageScope(scope, async () => {
    const turn = provider.streamTurn({
      instructions: "x".repeat(400),
      input: [],
      tools: [],
      tier: "fast",
      ...(signal ? { signal } : {}),
    });
    for await (const _ of turn) void _;
  }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 5));
  return rows;
}

afterEach(() => setUsageSink(null));

describe("usage of a model call", () => {
  it("records a completed call once, with the provider's numbers and id", async () => {
    const rows = await run(
      client(async function* () {
        yield { type: "response.output_item.added" };
        yield completed;
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "succeeded",
      cost_status: "actual",
      cached_tokens: 400,
      cache_write_tokens: 100,
      idempotency_key: "openai:resp_1",
    });
  });

  it("records a stream cut halfway as an estimate, without the text", async () => {
    const rows = await run(
      client(async function* () {
        yield { type: "response.output_item.added" };
        yield { type: "response.output_text.delta", delta: "secreto del usuario" };
        throw new Error("connection lost");
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "cancelled", cost_status: "estimated" });
    expect(Number(rows[0]!.budget_micro)).toBeGreaterThan(0);
    expect(JSON.stringify(rows[0])).not.toContain("secreto");
  });

  it("counts a stalled attempt and its retry separately, not three times", async () => {
    let call = 0;
    const rows = await run(
      client(async function* (signal) {
        if (call++ === 0)
          await new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(new Error("aborted"))),
          );
        yield { type: "response.output_item.added" };
        yield completed;
      }),
    );
    expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "succeeded"]);
  });

  it("records nothing as spent when the request never reached the provider", async () => {
    const rows = await run({
      responses: {
        create: vi.fn(async () => {
          throw new Error("timeout before the call");
        }),
      },
    } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", budget_micro: 0 });
  });
});
