import type { AIProvider, AIStreamEvent, AITurnRequest } from "@/core/agents/ai-provider";
import type { ActionLog, ExecutorPorts, StoredAction } from "@/core/agents/executor";
import { ToolRegistry, type ProviderFactory, type ToolContext } from "@/core/agents/tools";
import type { Task, TaskProvider, TaskQuery } from "@/core/capabilities/tasks";
import { AppError } from "@/core/errors";
import { makeExternalRef } from "@/core/providers/refs";
import type { CapabilityBinding } from "@/core/providers/types";
import { CALENDAR_TOOLS } from "@/core/tools/calendar";
import { TASK_TOOLS } from "@/core/tools/tasks";

export const NATIVE_BINDING: CapabilityBinding = {
  id: "binding-native",
  capability: "tasks",
  connectionId: "conn-native",
  providerKey: "elise_native",
  connectionStatus: "connected",
  contextType: null,
  contextId: null,
  priority: 100,
  isDefault: true,
  enabled: true,
  label: "ELISE",
  accountLabel: null,
  contextLabel: null,
};

export class InMemoryTaskProvider implements TaskProvider {
  tasks = new Map<string, Task>();

  constructor(
    private readonly connectionId = "conn-native",
    private readonly source = "ELISE",
    private readonly providerKey: "elise_native" | "google" = "elise_native",
  ) {}

  async listLists() {
    return [
      {
        id: "default",
        name: "Tasks",
        provenance: {
          providerKey: this.providerKey,
          connectionId: this.connectionId,
          source: this.source,
        },
      },
    ];
  }

  async list(query: TaskQuery): Promise<Task[]> {
    return [...this.tasks.values()].filter((t) => {
      if (query.status === "open" && (t.status === "completed" || t.status === "cancelled"))
        return false;
      if (query.status === "completed" && t.status !== "completed") return false;
      if (query.search && !t.title.toLowerCase().includes(query.search.toLowerCase())) return false;
      if (query.dueFrom && (!t.dueDate || t.dueDate < query.dueFrom)) return false;
      if (query.dueTo && (!t.dueDate || t.dueDate > query.dueTo)) return false;
      return true;
    });
  }
  async get(id: string) {
    return this.tasks.get(id) ?? null;
  }
  async create(input: { title: string; dueDate?: string }): Promise<Task> {
    const now = new Date().toISOString();
    const uuid = crypto.randomUUID();
    const task: Task = {
      // External providers use connection-scoped refs; ELISE uses UUIDs (like production).
      id:
        this.providerKey === "elise_native"
          ? uuid
          : makeExternalRef(this.connectionId, "task", "default", uuid),
      title: input.title,
      description: null,
      notes: null,
      status: "pending",
      priority: null,
      category: null,
      dueDate: input.dueDate ?? null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      provenance: {
        providerKey: this.providerKey,
        connectionId: this.connectionId,
        externalId: "",
        source: this.source,
      },
    };
    task.provenance.externalId = task.id;
    this.tasks.set(task.id, task);
    return task;
  }
  async update(input: { taskId: string; title?: string }) {
    const task = this.require(input.taskId);
    if (input.title) task.title = input.title;
    return task;
  }
  async complete(id: string) {
    const task = this.require(id);
    task.status = "completed";
    task.completedAt = new Date().toISOString();
    return task;
  }
  async reopen(id: string) {
    const task = this.require(id);
    task.status = "pending";
    task.completedAt = null;
    return task;
  }
  async archive(id: string) {
    const task = this.require(id);
    this.tasks.delete(id);
    return task;
  }
  private require(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new AppError("NOT_FOUND", "Task not found");
    return task;
  }
}

export class InMemoryActionLog implements ActionLog {
  actions = new Map<string, StoredAction & { idempotencyKey: string | null; input: unknown }>();
  approvals: { id: string; actionId: string; summary: string; payloadHash: string }[] = [];
  executions: { toolName: string; status: string }[] = [];
  auditEvents: { eventType: string; result: string }[] = [];

  async recordAction(_ctx: ToolContext, action: Parameters<ActionLog["recordAction"]>[1]) {
    const existing = [...this.actions.values()].find(
      (a) => action.idempotencyKey && a.idempotencyKey === action.idempotencyKey,
    );
    if (existing) return { action: existing, duplicate: true };
    const stored = {
      id: crypto.randomUUID(),
      status: action.status,
      resultReference: null,
      idempotencyKey: action.idempotencyKey,
      input: action.input,
    };
    this.actions.set(stored.id, stored);
    return { action: stored, duplicate: false };
  }
  async finishAction(
    _ctx: ToolContext,
    id: string,
    result: Parameters<ActionLog["finishAction"]>[2],
  ) {
    const a = this.actions.get(id)!;
    a.status = result.status;
    a.resultReference = result.resultReference ?? null;
  }
  async requestApproval(_ctx: ToolContext, approval: Parameters<ActionLog["requestApproval"]>[1]) {
    const id = crypto.randomUUID();
    this.approvals.push({
      id,
      actionId: approval.actionId,
      summary: approval.summary,
      payloadHash: approval.payloadHash,
    });
    return { id };
  }
  async recordToolExecution(_ctx: ToolContext, e: Parameters<ActionLog["recordToolExecution"]>[1]) {
    this.executions.push({ toolName: e.toolName, status: e.status });
  }
  async audit(_ctx: ToolContext, e: Parameters<ActionLog["audit"]>[1]) {
    this.auditEvents.push({ eventType: e.eventType, result: e.result });
  }
}

/** A binding for another account (e.g. a Google connection) with its own id and labels. */
export function binding(
  over: Partial<CapabilityBinding> & Pick<CapabilityBinding, "connectionId">,
): CapabilityBinding {
  return { ...NATIVE_BINDING, id: `b-${over.connectionId}`, isDefault: false, ...over };
}

/**
 * Executor ports over in-memory providers. `providers` maps connectionId → provider so tests can
 * run several accounts side by side; the default is a single ELISE Tasks provider.
 */
export function makePorts(
  bindings: CapabilityBinding[] = [NATIVE_BINDING],
  providers: Record<string, unknown> = {},
) {
  const tasks = new InMemoryTaskProvider();
  const log = new InMemoryActionLog();
  const ports: ExecutorPorts = {
    registry: new ToolRegistry().register(...TASK_TOOLS, ...CALENDAR_TOOLS),
    providers: {
      get: ((_capability: string, b: CapabilityBinding) =>
        providers[b.connectionId] ?? tasks) as ProviderFactory["get"],
    },
    log,
    loadBindings: async () => bindings,
    permissionFor: async () => "write",
  };
  return { ports, tasks, log };
}

export function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceId: "ws-1",
    userId: "user-1",
    timezone: "America/Argentina/Buenos_Aires",
    locale: "es",
    now: new Date("2026-09-29T15:00:00Z"),
    origin: "ai",
    aiRunId: "run-1",
    ...overrides,
  };
}

/** AI provider that replays a script: each turn is a list of events. Records requests. */
export class ScriptedAI implements AIProvider {
  readonly id = "scripted";
  requests: AITurnRequest[] = [];
  constructor(private readonly turns: ((req: AITurnRequest) => AIStreamEvent[])[]) {}

  async *streamTurn(request: AITurnRequest): AsyncIterable<AIStreamEvent> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    const turn = this.turns[this.requests.length - 1];
    if (!turn) throw new Error("ScriptedAI ran out of turns");
    for (const event of turn(request)) yield event;
  }
}
