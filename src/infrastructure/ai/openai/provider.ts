import "server-only";

import OpenAI from "openai";

import type {
  AIInputItem,
  AIProvider,
  AIStreamEvent,
  AITurnRequest,
} from "@/core/agents/ai-provider";
import { AppError } from "@/core/errors";
import { recordUsage } from "@/infrastructure/observability/usage";

/** OpenAI function names allow [a-zA-Z0-9_-]; ELISE tool names use dots ("tasks.create"). */
const encodeName = (name: string) => name.replaceAll(".", "__");
const decodeName = (name: string) => name.replaceAll("__", ".");

export interface OpenAIProviderOptions {
  apiKey: string;
  models: { standard: string; fast: string };
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

  async *streamTurn(request: AITurnRequest): AsyncIterable<AIStreamEvent> {
    const model = this.options.models[request.tier];
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
          // Only reasoning models accept an effort; others ignore the hint.
          ...(request.reasoning && /^(gpt-5|o\d)/.test(model)
            ? { reasoning: { effort: request.reasoning } }
            : {}),
        },
        { signal: request.signal },
      );
    } catch (error) {
      recordUsage({ operation: "llm", provider: this.id, model, status: "failed" });
      throw normalizeError(error);
    }

    try {
      for await (const event of stream) {
        switch (event.type) {
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
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403) {
      return new AppError("AI_NOT_CONFIGURED", "The AI provider rejected the credentials", {
        recovery: "configure",
      });
    }
    if (error.status === 429)
      return new AppError("RATE_LIMITED", "The AI provider is busy. Try again shortly.");
    if (error.status === 400) {
      return new AppError("AI_PROVIDER_ERROR", "The AI provider rejected the request", {
        details: { providerStatus: 400 },
      });
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new AppError("TIMEOUT", "The response was cancelled");
  }
  return new AppError("AI_PROVIDER_ERROR", "The AI provider is not responding", { cause: error });
}
