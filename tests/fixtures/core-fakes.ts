import type { AIProvider, AIStreamEvent, AITurnRequest } from "@/core/agents/ai-provider";
import type { ActionLog, ExecutorPorts, StoredAction } from "@/core/agents/executor";
import { ToolRegistry, type ToolContext } from "@/core/agents/tools";
import type { Task, TaskProvider, TaskQuery } from "@/core/capabilities/tasks";
import { AppError } from "@/core/errors";
import type { CapabilityBinding } from "@/core/providers/types";
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
};

export class InMemoryTaskProvider implements TaskProvider {
  tasks = new Map<string, Task>();

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
    const task: Task = {
      id: crypto.randomUUID(),
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
      provenance: { providerKey: "elise_native", connectionId: "conn-native", externalId: "" },
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

export function makePorts(bindings: CapabilityBinding[] = [NATIVE_BINDING]) {
  const tasks = new InMemoryTaskProvider();
  const log = new InMemoryActionLog();
  const ports: ExecutorPorts = {
    registry: new ToolRegistry().register(...TASK_TOOLS),
    providers: { get: () => tasks },
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
