import { z } from "zod";

import type { AIToolSpec } from "./ai-provider";
import type { CalendarEvent, CalendarInfo, CalendarProvider } from "../capabilities/calendar";
import type {
  EmailDraft,
  EmailMessage,
  EmailProvider,
  EmailThread,
  FollowUp,
} from "../capabilities/email";
import type { Goal, GoalProgress, GoalsProvider } from "../capabilities/goals";
import type { HabitProgress, HabitsProvider } from "../capabilities/habits";
import type { ListsProvider, NativeList } from "../capabilities/lists";
import type { Note, NotesProvider } from "../capabilities/notes";
import { getCapability } from "../capabilities/registry";
import type { Task, TaskList, TaskProvider } from "../capabilities/tasks";
import type { CapabilityKey, OperationDefinition } from "../capabilities/types";
import type { KnowledgeReader } from "../knowledge/model";
import type { CapabilityBinding, ProviderKey } from "../providers/types";
import type { ScheduleInput } from "../schedules/schedule";

export type ActionOrigin = "ai" | "user_ui" | "schedule" | "system";

export interface ToolContext {
  workspaceId: string;
  userId: string;
  timezone: string;
  locale: "es" | "en";
  now: Date;
  origin: ActionOrigin;
  aiRunId: string | null;
  /** The Knowledge Space the conversation is in, if any: searched first. */
  knowledgeSpaceId?: string | null;
}

/** Capability → provider contract. Grows as capabilities are implemented. */
export interface CapabilityProviders {
  tasks: TaskProvider;
  calendar: CalendarProvider;
  email: EmailProvider;
  /** ELISE's own index, whatever source fed it. */
  knowledge: KnowledgeReader;
  habits: HabitsProvider;
  goals: GoalsProvider;
  lists: ListsProvider;
  notes: NotesProvider;
}

export type ImplementedCapability = keyof CapabilityProviders;

export interface ProviderFactory {
  get<C extends ImplementedCapability>(
    capability: C,
    binding: CapabilityBinding,
  ): CapabilityProviders[C];
}

/** One cited passage: enough to show and open the source, never the whole document. */
export interface KnowledgeEvidence {
  ref: number;
  itemId: string;
  chunkId: string;
  title: string;
  section: string | null;
  page: number | null;
  sourceType: string;
  url: string | null;
  versionNumber: number;
  spaceName: string;
  snippet: string;
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
    }
  /** Message lists never carry bodies (compact, and safe to keep in history). */
  | { kind: "email_list"; messages: EmailMessage[]; unavailable?: string[] }
  | { kind: "email_thread"; thread: EmailThread }
  | {
      kind: "email_draft";
      draft: EmailDraft;
      change: "created" | "updated" | "sent" | "discarded" | "preview";
      /** Recipients outside the sender's organization. */
      external: string[];
      /** People reply-all added beyond a plain reply. */
      addedByReplyAll?: string[];
      /** Fingerprint of exactly this content; sending from the card is pinned to it. */
      version?: string;
    }
  | {
      kind: "email_followups";
      followUp: "needs_reply" | "waiting_on_others";
      items: FollowUp[];
    }
  /** Native data, computed by ELISE (progress is never the model's arithmetic). */
  | { kind: "habits"; progress: HabitProgress[] }
  | { kind: "goals"; goals: { goal: Goal; progress: GoalProgress; openTasks: number }[] }
  | { kind: "native_list"; list: NativeList }
  | { kind: "note"; note: Note; change: "created" | "updated" | "archived" }
  | { kind: "notes"; notes: Note[] }
  | {
      /** Evidence behind a Knowledge answer: what the citations [n] point to. */
      kind: "knowledge_evidence";
      scope: string[];
      enough: boolean;
      evidence: KnowledgeEvidence[];
    }
  | {
      /** A Schedule ELISE proposes; created only when the user confirms. */
      kind: "schedule_proposal";
      input: ScheduleInput;
      nextRunAt: string;
    }
  | {
      kind: "email_changed";
      change: "archived" | "read" | "unread";
      count: number;
      source: string;
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
  capability: CapabilityKey;
  operation: string;
  description: string;
  input: z.ZodType<TInput>;
  /** Human summary of what will happen, shown in approvals ("Delete task “Buy milk”"). */
  describe(
    input: TInput,
    env: ToolRunEnv,
  ): Promise<{
    summary: string;
    target?: { type: string; id: string };
    /** What the user reviews before approving (e.g. the exact email that will be sent). */
    preview?: ToolDisplay;
  }>;
  /**
   * Pins the exact content a write acts on before it is hashed and approved (e.g. the draft's
   * current version). The pinned input is what runs, so later edits invalidate the approval.
   */
  pin?(input: TInput, env: ToolRunEnv): Promise<TInput>;
  /** New outbound writes: ask which account instead of using the global default. */
  strictDestination?: boolean;
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
    return [...this.tools.values()].filter(
      (t) => capabilities.has(t.capability) || getCapability(t.capability).internal,
    );
  }

  static toSpec(tool: AnyToolDefinition): AIToolSpec {
    return {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>,
    };
  }
}
