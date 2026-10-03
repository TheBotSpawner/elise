import "server-only";

import OpenAI from "openai";

import type {
  AIInputItem,
  AIProvider,
  AIStreamEvent,
  AITurnRequest,
  ModelTier,
} from "@/core/agents/ai-provider";
import { AppError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";
import { recordUsage } from "@/infrastructure/observability/usage";

import { effortFor, type AIProfile } from "../profiles";

/** No output this long from a fast or standard call: treated as a provider stall (see streamTurn). */
const FIRST_OUTPUT_MS = 8_000;

/** OpenAI function names allow [a-zA-Z0-9_-]; ELISE tool names use dots ("tasks.create"). */
const encodeName = (name: string) => name.replaceAll(".", "__");
const decodeName = (name: string) => name.replaceAll("__", ".");

export interface OpenAIProviderOptions {
  apiKey: string;
  /** What each tier means (AI_PROFILE_*), resolved once from configuration. */
  profiles: Record<ModelTier, AIProfile>;
  /** No output this long from a fast or standard call = a stall (default FIRST_OUTPUT_MS). */
  firstOutputMs?: number;
}

/**
 * OpenAI adapter for the AIProvider port. One streamed model turn per call; ELISE Core owns the
 * tool loop, validation, policy and persistence. Stateless (`store: false`): conversation state
 * lives in ELISE, not in the provider.
 */
export class OpenAIProvider implements AIProvider {
  readonly id = "openai";
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.client = new OpenAI({ apiKey: options.apiKey, maxRetries: 2, timeout: 60_000 });
  }

  /** Tests replace the SDK client. */
  static withClient(options: OpenAIProviderOptions, client: OpenAI): OpenAIProvider {
    const p = new OpenAIProvider(options);
    (p as unknown as { client: OpenAI }).client = client;
    return p;
  }

  /**
   * One model turn, guarded against provider stalls: measured first-output times for fast calls
   * are 1.4 s p50 / 7.7 s p99, but ~1% stall for 19–30 s with no output at all. When nothing
   * has been produced after FIRST_OUTPUT_MS, the call is abandoned and retried once (nothing
   * was streamed, so retrying is safe). Deep synthesis may legitimately think longer: unguarded.
   */
  async *streamTurn(request: AITurnRequest): AsyncIterable<AIStreamEvent> {
    const guarded = request.tier !== "deep";
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const relay = () => controller.abort();
      request.signal?.addEventListener("abort", relay, { once: true });
      let produced = false;
      let stalled = false;
      const timer =
        guarded && attempt === 0
          ? setTimeout(() => {
              stalled = true;
              controller.abort();
            }, this.options.firstOutputMs ?? FIRST_OUTPUT_MS)
          : undefined;
      try {
        yield* this.attempt(request, controller.signal, () => {
          produced = true;
          clearTimeout(timer);
        });
        return;
      } catch (error) {
        if (stalled && !produced && !request.signal?.aborted) {
          recordUsage({
            operation: "llm",
            provider: this.id,
            model: this.options.profiles[request.tier].model,
            status: "failed",
          });
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", relay);
      }
    }
  }

  private async *attempt(
    request: AITurnRequest,
    signal: AbortSignal,
    onOutput: () => void,
  ): AsyncIterable<AIStreamEvent> {
    const profile = this.options.profiles[request.tier];
    const model = profile.model;
    const effort = effortFor(model, request.reasoning ?? profile.reasoning);
    const started = Date.now();
    let stream;
    try {
      stream = await this.client.responses.create(
        {
          model,
          instructions: request.instructions,
          input: request.input.map(toOpenAIItem),
          tools: request.tools.map((t) => ({
            type: "function" as const,
            name: encodeName(t.name),
            description: t.description,
            parameters: t.parameters,
            strict: false,
          })),
          stream: true,
          store: false,
          // One routing key for ELISE turns: requests sharing the stable prefix (instructions,
          // core tools) land where it is cached (ADR-025).
          prompt_cache_key: `elise:${request.tier}`,
          // Only reasoning models accept an effort, each its own set (effortFor).
          ...(effort ? { reasoning: { effort } } : {}),
          // Fast mode (priority processing) only where the profile asks for it.
          ...(profile.serviceTier ? { service_tier: profile.serviceTier } : {}),
        },
        { signal },
      );
    } catch (error) {
      recordUsage({ operation: "llm", provider: this.id, model, status: "failed" });
      throw normalizeError(error);
    }

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "response.output_item.added":
            onOutput();
            break;
          case "response.output_text.delta":
            yield { type: "text_delta", delta: event.delta };
            break;
          case "response.output_item.done":
            if (event.item.type === "function_call") {
              yield {
                type: "tool_call",
                callId: event.item.call_id,
                name: decodeName(event.item.name),
                arguments: event.item.arguments,
              };
            }
            break;
          case "response.completed": {
            const usage = event.response.usage;
            const cachedTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
            const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ?? 0;
            recordUsage({
              operation: "llm",
              provider: this.id,
              model: event.response.model,
              inputTokens: usage?.input_tokens ?? null,
              outputTokens: usage?.output_tokens ?? null,
              cachedTokens,
              reasoningTokens,
              latencyMs: Date.now() - started,
            });
            yield {
              type: "completed",
              model: event.response.model,
              serviceTier: event.response.service_tier ?? null,
              effort,
              usage: usage
                ? {
                    inputTokens: usage.input_tokens,
                    outputTokens: usage.output_tokens,
                    cachedTokens,
                    reasoningTokens,
                  }
                : null,
            };
            break;
          }
          case "response.failed":
          case "error":
            throw new AppError(
              "AI_PROVIDER_ERROR",
              "The AI provider could not complete the response",
            );
        }
      }
    } catch (error) {
      throw normalizeError(error);
    }
  }
}

function toOpenAIItem(item: AIInputItem): OpenAI.Responses.ResponseInputItem {
  switch (item.type) {
    case "message":
      if (item.role === "user" && item.images?.length)
        return {
          role: "user",
          content: [
            { type: "input_text", text: item.content },
            ...item.images.map((url) => ({
              type: "input_image" as const,
              image_url: url,
              detail: "auto" as const,
            })),
          ],
        };
      return { role: item.role, content: item.content };
    case "tool_call":
      return {
        type: "function_call",
        call_id: item.callId,
        name: encodeName(item.name),
        arguments: item.arguments,
      };
    case "tool_result":
      return { type: "function_call_output", call_id: item.callId, output: item.output };
  }
}

/** Translate provider errors into ELISE errors; raw provider messages never leave this file. */
function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  // Billing problems are configuration, not an outage: say so (the account owner can fix it).
  const code = (error as { code?: unknown } | null)?.code;
  if (
    code === "credit_balance_exhausted" ||
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached"
  )
    return new AppError("AI_NOT_CONFIGURED", "ELISE's AI account has no credits left", {
      recovery: "configure",
      details: { providerCode: code },
    });
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403) {
      return new AppError("AI_NOT_CONFIGURED", "The AI provider rejected the credentials", {
        recovery: "configure",
      });
    }
    if (error.status === 429)
      return new AppError("RATE_LIMITED", "The AI provider is busy. Try again shortly.");
    if (error.status === 400) {
      // Which part of the request was rejected (codes and params only, never content).
      logger.warn("ai.provider_rejected", {
        code: error.code ?? null,
        param: error.param ?? null,
        type: error.type ?? null,
      });
      return new AppError("AI_PROVIDER_ERROR", "The AI provider rejected the request", {
        details: { providerStatus: 400 },
      });
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new AppError("TIMEOUT", "The response was cancelled");
  }
  logger.warn("ai.provider_error", {
    name: error instanceof Error ? error.name : typeof error,
    status: error instanceof OpenAI.APIError ? error.status : null,
    code: error instanceof OpenAI.APIError ? (error.code ?? null) : null,
    message: error instanceof Error ? error.message.slice(0, 200) : null,
  });
  return new AppError("AI_PROVIDER_ERROR", "The AI provider is not responding", { cause: error });
}
