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

/** Like the real SDK: an aborted stream ENDS quietly (no throw); "truncated" never completes. */
function sdkLikeClient(plan: ("quiet_stall" | "slow" | "truncated" | "answer")[]) {
  let call = 0;
  const bodies: unknown[] = [];
  return {
    calls: () => call,
    bodies,
    responses: {
      create: async (body: unknown, opts: { signal: AbortSignal }) => {
        bodies.push(body);
        const kind = plan[call++] ?? "answer";
        return (async function* (): AsyncGenerator<Ev> {
          yield { type: "response.created" };
          if (kind === "quiet_stall") {
            await new Promise<void>((resolve) =>
              opts.signal.addEventListener("abort", () => resolve()),
            );
            return;
          }
          if (kind === "slow") await new Promise((r) => setTimeout(r, 60));
          yield { type: "response.output_item.added" };
          yield { type: "response.output_text.delta", delta: "Listo" };
          if (kind === "truncated") return;
          yield {
            type: "response.completed",
            response: { model: "m", usage: { input_tokens: 1, output_tokens: 1 } },
          };
        })();
      },
    },
  };
}

const IMAGE = { url: "data:image/jpeg;base64,/9j/AAA", detail: "high" as const };

describe("provider: image turns and silent endings (ADR-060)", () => {
  it("a stall the SDK ends quietly is still retried — never an empty answer", async () => {
    const client = sdkLikeClient(["quiet_stall", "answer"]);
    const p = OpenAIProvider.withClient(
      { apiKey: "k", profiles: DEFAULT_PROFILES, firstOutputMs: 30 },
      client as never,
    );
    await expect(collect(p, "fast")).resolves.toBe("Listo");
    expect(client.calls()).toBe(2);
  });

  it("images get a longer first-output budget than text", async () => {
    const client = sdkLikeClient(["slow"]);
    const p = OpenAIProvider.withClient(
      { apiKey: "k", profiles: DEFAULT_PROFILES, firstOutputMs: 20, imageFirstOutputMs: 2_000 },
      client as never,
    );
    const out: string[] = [];
    for await (const e of p.streamTurn({
      instructions: "",
      input: [{ type: "message", role: "user", content: "¿Qué dice?", images: [IMAGE] }],
      tools: [],
      tier: "fast",
    }))
      if (e.type === "text_delta") out.push(e.delta);
    expect(out.join("")).toBe("Listo");
    // Not cut and retried: the image was given time to be read.
    expect(client.calls()).toBe(1);
  });

  it("the image itself goes to the model, with its detail, next to the text", async () => {
    const client = sdkLikeClient(["answer"]);
    const p = OpenAIProvider.withClient(
      { apiKey: "k", profiles: DEFAULT_PROFILES },
      client as never,
    );
    const events = [];
    for await (const e of p.streamTurn({
      instructions: "",
      input: [{ type: "message", role: "user", content: "Agregalos", images: [IMAGE] }],
      tools: [],
      tier: "fast",
    }))
      events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "completed" });
    const input = (client.bodies[0] as { input: { content: unknown }[] }).input[0]!.content;
    expect(input).toEqual([
      { type: "input_text", text: "Agregalos" },
      { type: "input_image", image_url: IMAGE.url, detail: "high" },
    ]);
  });

  it("a stream that stops before completing is an error, not an answer", async () => {
    const client = sdkLikeClient(["truncated"]);
    const p = OpenAIProvider.withClient(
      { apiKey: "k", profiles: DEFAULT_PROFILES },
      client as never,
    );
    await expect(collect(p, "fast")).rejects.toMatchObject({ code: "AI_PROVIDER_ERROR" });
  });
});
