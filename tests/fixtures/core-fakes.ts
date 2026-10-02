import type { AIProvider, AIStreamEvent, AITurnRequest } from "@/core/agents/ai-provider";
import type { ActionLog, ExecutorPorts, StoredAction } from "@/core/agents/executor";
import { ToolRegistry, type ProviderFactory, type ToolContext } from "@/core/agents/tools";
import type {
  EmailDraft,
  EmailMessage,
  EmailProvider,
  EmailQuery,
  EmailThread,
  NewDraft,
} from "@/core/capabilities/email";
import type { Task, TaskProvider, TaskQuery } from "@/core/capabilities/tasks";
import { AppError } from "@/core/errors";
import { makeExternalRef } from "@/core/providers/refs";
import type { CapabilityBinding } from "@/core/providers/types";
import { CALENDAR_TOOLS } from "@/core/tools/calendar";
import { CONTEXT_TOOLS } from "@/core/tools/contexts";
import { EMAIL_TOOLS } from "@/core/tools/email";
import { FINANCE_TOOLS } from "@/core/tools/finance";
import { GOAL_TOOLS } from "@/core/tools/goals";
import { HABIT_TOOLS } from "@/core/tools/habits";
import { HISTORY_TOOLS } from "@/core/tools/history";
import { KNOWLEDGE_TOOLS } from "@/core/tools/knowledge";
import { LIST_TOOLS } from "@/core/tools/lists";
import { LOCATION_TOOLS } from "@/core/tools/location";
import { MEETING_TOOLS } from "@/core/tools/meeting";
import { NOTE_TOOLS } from "@/core/tools/notes";
import { PLANNING_TOOLS } from "@/core/tools/planning";
import { SCHEDULE_TOOLS } from "@/core/tools/schedules";
import { SETTINGS_TOOLS } from "@/core/tools/settings";
import { SHORTCUT_TOOLS } from "@/core/tools/shortcuts";
import { STRUCTURED_TOOLS } from "@/core/tools/structured";
import { STUDY_TOOLS } from "@/core/tools/study";
import { TASK_TOOLS } from "@/core/tools/tasks";
import { WEB_TOOLS } from "@/core/tools/web";
import { WORKSPACE_TOOLS } from "@/core/tools/workspace";

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
  approvals: {
    id: string;
    actionId: string;
    summary: string;
    payloadHash: string;
    connectionId: string;
    payload: unknown;
  }[] = [];
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
      connectionId: approval.connectionId,
      payload: approval.payload,
    });
    return { id };
  }
  /** Approvals decided in a test (the fake has no status column). */
  decided = new Set<string>();
  async findPendingApproval(_ctx: ToolContext, payloadHash: string) {
    const a = this.approvals.find((x) => x.payloadHash === payloadHash && !this.decided.has(x.id));
    return a ? { approvalId: a.id, actionId: a.actionId } : null;
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
    registry: new ToolRegistry().register(
      ...TASK_TOOLS,
      ...CALENDAR_TOOLS,
      ...EMAIL_TOOLS,
      ...SCHEDULE_TOOLS,
      ...KNOWLEDGE_TOOLS,
      ...HABIT_TOOLS,
      ...GOAL_TOOLS,
      ...LIST_TOOLS,
      ...NOTE_TOOLS,
      ...FINANCE_TOOLS,
      ...STRUCTURED_TOOLS,
      ...HISTORY_TOOLS,
      ...SETTINGS_TOOLS,
      ...WORKSPACE_TOOLS,
      ...MEETING_TOOLS,
      ...WEB_TOOLS,
      ...LOCATION_TOOLS,
      ...CONTEXT_TOOLS,
      ...STUDY_TOOLS,
      ...PLANNING_TOOLS,
      ...SHORTCUT_TOOLS,
    ),
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

/** In-memory mailbox for one account. Refs follow the production format (x:{conn}:m|t|d:id). */
export class InMemoryEmailProvider implements EmailProvider {
  messages: EmailMessage[] = [];
  drafts = new Map<string, EmailDraft>();
  sent: EmailDraft[] = [];
  modified: { ids: string[]; change: { archive?: boolean; read?: boolean } }[] = [];
  /** Makes the next send fail with this error (after optionally "really" sending). */
  sendFailure: { error: Error; actuallySent: boolean } | null = null;
  failReads: Error | null = null;

  constructor(
    readonly connectionId: string,
    readonly source: string,
    readonly account: string,
  ) {}

  ref(kind: "m" | "t" | "d", id: string) {
    return makeExternalRef(this.connectionId, kind, id);
  }

  addMessage(over: Partial<EmailMessage> & { id: string; threadId: string }): EmailMessage {
    const m: EmailMessage = {
      from: { email: "alex@client.com", name: "Alex" },
      to: [{ email: this.account, name: null }],
      cc: [],
      replyTo: [],
      subject: "Proposal",
      snippet: "",
      date: "2026-09-28T12:00:00.000Z",
      unread: true,
      inInbox: true,
      important: false,
      fromMe: false,
      category: "primary",
      labels: [],
      attachments: [],
      bulk: false,
      body: null,
      rfcMessageId: `<${over.id}@mail>`,
      references: null,
      url: null,
      ...over,
      id: this.ref("m", over.id),
      threadId: this.ref("t", over.threadId),
      provenance: {
        providerKey: "google",
        connectionId: this.connectionId,
        externalId: over.id,
        source: this.source,
        account: this.account,
      },
    };
    this.messages.push(m);
    return m;
  }

  async search(q: EmailQuery) {
    if (this.failReads) throw this.failReads;
    return this.messages
      .filter((m) => !q.from || (m.from?.email ?? "").includes(q.from))
      .filter((m) => !q.inInbox || m.inInbox)
      .slice(0, q.limit)
      .map((m) => ({ ...m, body: null }));
  }
  async searchThreads(q: EmailQuery): Promise<EmailThread[]> {
    const ids = [...new Set((await this.search({ ...q, limit: 100 })).map((m) => m.threadId))];
    return ids.map((id) => this.thread(id)!);
  }
  private thread(id: string): EmailThread | null {
    const messages = this.messages
      .filter((m) => m.threadId === id)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!messages.length) return null;
    return {
      id,
      subject: messages[0]!.subject,
      messages,
      url: null,
      provenance: { ...messages[0]!.provenance },
    };
  }
  async getMessage(id: string) {
    return this.messages.find((m) => m.id === id) ?? null;
  }
  async peek(ids: string[]) {
    return this.messages.filter((m) => ids.includes(m.id) || ids.includes(m.threadId));
  }
  async getThread(id: string) {
    return this.thread(id);
  }
  async getDraft(id: string) {
    return this.drafts.get(id) ?? null;
  }
  private save(id: string, d: NewDraft): EmailDraft {
    const draft: EmailDraft = {
      id,
      threadId: d.reply?.threadId ?? null,
      from: this.account,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      body: d.body,
      inReplyTo: d.reply?.inReplyTo ?? null,
      references: d.reply?.references ?? null,
      url: null,
      provenance: {
        providerKey: "google",
        connectionId: this.connectionId,
        externalId: id,
        source: this.source,
        account: this.account,
      },
    };
    this.drafts.set(id, draft);
    return draft;
  }
  async createDraft(d: NewDraft) {
    return this.save(this.ref("d", crypto.randomUUID()), d);
  }
  async updateDraft(id: string, d: NewDraft) {
    if (!this.drafts.has(id)) throw new AppError("NOT_FOUND", "Draft not found");
    return this.save(id, d);
  }
  async sendDraft(id: string): Promise<EmailMessage> {
    const draft = this.drafts.get(id);
    if (!draft) throw new AppError("NOT_FOUND", "Draft not found");
    const failure = this.sendFailure;
    this.sendFailure = null;
    if (failure && !failure.actuallySent) throw failure.error;
    this.drafts.delete(id);
    this.sent.push(draft);
    if (failure) throw failure.error;
    return this.addMessage({
      id: `sent-${this.sent.length}`,
      threadId: draft.threadId?.split(":").at(-1) ?? `new-${this.sent.length}`,
      fromMe: true,
      subject: draft.subject,
    });
  }
  async deleteDraft(id: string) {
    this.drafts.delete(id);
  }
  async modify(ids: string[], change: { archive?: boolean; read?: boolean }) {
    this.modified.push({ ids, change });
  }
}
