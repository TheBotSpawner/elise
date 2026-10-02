import { describe, expect, it } from "vitest";

import { OpenAIProvider } from "@/infrastructure/ai/openai/provider";
import { DEFAULT_PROFILES } from "@/infrastructure/ai/profiles";

type Ev = { type: string; [k: string]: unknown };

/** A fake Responses stream: either stalls (no output until aborted) or answers. */
function fakeClient(plan: ("stall" | "answer")[]) {
  let call = 0;
  return {
    calls: () => call,
    responses: {
      create: async (_body: unknown, opts: { signal: AbortSignal }) => {
        const kind = plan[call++] ?? "answer";
        return (async function* (): AsyncGenerator<Ev> {
          yield { type: "response.created" };
          if (kind === "stall") {
            await new Promise((_, reject) =>
              opts.signal.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              ),
            );
          }
          yield { type: "response.output_item.added" };
          yield { type: "response.output_text.delta", delta: "Hola" };
          yield {
            type: "response.completed",
            response: { model: "m", usage: { input_tokens: 1, output_tokens: 1 } },
          };
        })();
      },
    },
  };
}

async function collect(p: OpenAIProvider, tier: "fast" | "deep") {
  const out: string[] = [];
  for await (const e of p.streamTurn({ instructions: "", input: [], tools: [], tier }))
    if (e.type === "text_delta") out.push(e.delta);
  return out.join("");
}

describe("provider stall watchdog", () => {
  it("a fast call with no output in time is abandoned and retried once", async () => {
    const client = fakeClient(["stall", "answer"]);
    const p = OpenAIProvider.withClient(
      { apiKey: "k", profiles: DEFAULT_PROFILES, firstOutputMs: 30 },
      client as never,
    );
    await expect(collect(p, "fast")).resolves.toBe("Hola");
    expect(client.calls()).toBe(2);
  });

  it("deep synthesis may think longer: never cut", async () => {
    const client = fakeClient(["answer"]);
    const p = OpenAIProvider.withClient(
      { apiKey: "k", profiles: DEFAULT_PROFILES, firstOutputMs: 30 },
      client as never,
    );
    await expect(collect(p, "deep")).resolves.toBe("Hola");
    expect(client.calls()).toBe(1);
  });
});
