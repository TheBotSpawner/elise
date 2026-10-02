/**
 * Port between ELISE Core and any model runtime. ELISE owns the tool loop, policy and
 * persistence; a provider only performs one streamed model turn. Implementations live in
 * src/infrastructure/ai/ (OpenAI first). Core never imports a model SDK.
 */

/** Conversation items in provider-neutral form. */
export type AIInputItem =
  | { type: "message"; role: "user" | "assistant"; content: string }
  | { type: "tool_call"; callId: string; name: string; arguments: string }
  | { type: "tool_result"; callId: string; output: string };

export interface AIToolSpec {
  /** Capability-based name, e.g. "tasks.create". Adapters may encode it for their API. */
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

/** Model choice is policy, not feature code (docs/architecture/12 §15-16). */
export type ModelTier = "fast" | "standard";

export interface AITurnRequest {
  instructions: string;
  input: AIInputItem[];
  tools: AIToolSpec[];
  tier: ModelTier;
  /**
   * How much the model should deliberate, for reasoning models (ignored by others). Bounded
   * structured side tasks (a study question, an evaluation) use "minimal"/"low" for latency.
   */
  reasoning?: "minimal" | "low" | "medium";
  signal?: AbortSignal;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export type AIStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; callId: string; name: string; arguments: string }
  | { type: "completed"; model: string; usage: AIUsage | null };

export interface AIProvider {
  readonly id: string;
  streamTurn(request: AITurnRequest): AsyncIterable<AIStreamEvent>;
}
