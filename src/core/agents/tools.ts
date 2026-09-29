import { z } from "zod";

import type { AIToolSpec } from "./ai-provider";
import type { CalendarEvent, CalendarInfo, CalendarProvider } from "../capabilities/calendar";
import type { Task, TaskList, TaskProvider } from "../capabilities/tasks";
import type { CapabilityKey, OperationDefinition } from "../capabilities/types";
import type { CapabilityBinding, ProviderKey } from "../providers/types";

export type ActionOrigin = "ai" | "user_ui" | "schedule" | "system";

export interface ToolContext {
  workspaceId: string;
  userId: string;
  timezone: string;
  locale: "es" | "en";
  now: Date;
  origin: ActionOrigin;
  aiRunId: string | null;
}

/** Capability → provider contract. Grows as capabilities are implemented. */
export interface CapabilityProviders {
  tasks: TaskProvider;
  calendar: CalendarProvider;
}

export type ImplementedCapability = keyof CapabilityProviders;

export interface ProviderFactory {
  get<C extends ImplementedCapability>(
    capability: C,
    binding: CapabilityBinding,
  ): CapabilityProviders[C];
}

/** Structured payloads the UI renders as cards inside the conversation. */
export type ToolDisplay =
  | {
      kind: "task";
      task: Task;
      change: "created" | "updated" | "completed" | "reopened" | "deleted";
    }
  | { kind: "task_list"; tasks: Task[] }
  | { kind: "task_lists"; lists: TaskList[] }
  | {
      kind: "event";
      event: CalendarEvent;
      change: "created" | "updated" | "deleted";
    }
  | { kind: "event_list"; events: CalendarEvent[]; from: string; to: string }
  | { kind: "calendars"; calendars: CalendarInfo[] }
  | {
      kind: "availability";
      from: string;
      to: string;
      free: { start: string; end: string }[];
      busy: { start: string; end: string; source: string }[];
    };

export interface ToolRunEnv {
  ctx: ToolContext;
  binding: CapabilityBinding;
  providers: ProviderFactory;
  /** The recorded action for writes (stable across retries); null for reads. */
  actionId?: string | null;
}

export interface ToolRunResult<TOutput> {
  /** What the model sees. Must be safe and compact (no secrets, no raw provider payloads). */
  output: TOutput;
  display?: ToolDisplay;
  target?: { type: string; id: string };
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Capability-based name, never provider-based: "tasks.create", not "gmailSearch". */
  name: string;
  capability: ImplementedCapability & CapabilityKey;
  operation: string;
  description: string;
  input: z.ZodType<TInput>;
  /** Human summary of what will happen, shown in approvals ("Delete task “Buy milk”"). */
  describe(
    input: TInput,
    env: ToolRunEnv,
  ): Promise<{ summary: string; target?: { type: string; id: string } }>;
  run(input: TInput, env: ToolRunEnv): Promise<ToolRunResult<TOutput>>;
  /**
   * Existing items name the account they live in (see providers/refs.ts). Routing is still
   * validated against the workspace's bindings; an unknown connection fails closed.
   */
  route?(input: TInput): { connectionId?: string; providerKey?: ProviderKey } | null;
  /**
   * Deterministic, content-aware risk (e.g. an event with attendees is external
   * communication). Can only escalate; the model never lowers it.
   */
  assess?(input: TInput, env: ToolRunEnv): Promise<Partial<OperationDefinition> | null>;
  /** Combines a read across several accounts, preserving provenance. */
  merge?(
    results: { binding: CapabilityBinding; result: ToolRunResult<TOutput> }[],
    input: TInput,
    ctx: ToolContext,
  ): ToolRunResult<TOutput>;
}

// Registry entries are heterogeneous; `any` here is the standard variance escape for
// storing generic definitions. Inputs are validated by the tool's own schema before use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

/** Only registered tools can ever run (docs/engineering/17 §32). */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();

  register(...tools: AnyToolDefinition[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Tools exposed to the model: only those whose capability is currently available. */
  available(capabilities: ReadonlySet<CapabilityKey>): AnyToolDefinition[] {
    return [...this.tools.values()].filter((t) => capabilities.has(t.capability));
  }

  static toSpec(tool: AnyToolDefinition): AIToolSpec {
    return {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>,
    };
  }
}
