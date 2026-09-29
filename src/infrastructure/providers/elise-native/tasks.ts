import type {
  CreateTaskInput,
  Task,
  TaskProvider,
  TaskQuery,
  TaskWriteMeta,
  UpdateTaskInput,
} from "@/core/capabilities/tasks";
import { AppError } from "@/core/errors";
import type { TaskRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

const COLUMNS =
  "id, workspace_id, task_list_id, title, description, notes, status, priority, category, due_date, completed_at, created_by_user_id, source, metadata, created_at, updated_at, archived_at";

/**
 * ELISE Tasks: the Native provider for the Tasks capability. Supabase is the source of truth.
 * Every query is scoped to the workspace explicitly (defense in depth on top of RLS).
 */
export class EliseTasksProvider implements TaskProvider {
  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly connectionId: string,
  ) {}

  async list(query: TaskQuery): Promise<Task[]> {
    let q = this.db
      .from("tasks")
      .select(COLUMNS)
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(query.limit);

    if (query.status === "open") q = q.in("status", ["pending", "in_progress"]);
    if (query.status === "completed") q = q.eq("status", "completed");
    if (query.dueFrom) q = q.gte("due_date", query.dueFrom);
    if (query.dueTo) q = q.lte("due_date", query.dueTo);
    if (query.noDueDate) q = q.is("due_date", null);
    if (query.search) q = q.ilike("title", `%${escapeLike(query.search)}%`);

    const { data, error } = await q;
    if (error) throw dbError(error);
    return data.map((row) => this.toTask(row));
  }

  async get(taskId: string): Promise<Task | null> {
    const { data, error } = await this.db
      .from("tasks")
      .select(COLUMNS)
      .eq("workspace_id", this.workspaceId)
      .eq("id", taskId)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw dbError(error);
    return data ? this.toTask(data) : null;
  }

  async create(input: CreateTaskInput, meta: TaskWriteMeta): Promise<Task> {
    const { data, error } = await this.db
      .from("tasks")
      .insert({
        workspace_id: this.workspaceId,
        title: input.title,
        description: input.description ?? null,
        notes: input.notes ?? null,
        priority: input.priority ?? null,
        category: input.category ?? null,
        due_date: input.dueDate ?? null,
        created_by_user_id: meta.userId,
        source: meta.source,
      })
      .select(COLUMNS)
      .single();
    if (error) throw dbError(error);
    return this.toTask(data);
  }

  async update(input: UpdateTaskInput): Promise<Task> {
    const patch: Partial<TaskRow> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.status !== undefined) {
      patch.status = input.status;
      patch.completed_at = null;
    }
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.category !== undefined) patch.category = input.category;
    if (input.dueDate !== undefined) patch.due_date = input.dueDate;
    return this.patch(input.taskId, patch);
  }

  complete(taskId: string): Promise<Task> {
    return this.patch(taskId, { status: "completed", completed_at: new Date().toISOString() });
  }

  reopen(taskId: string): Promise<Task> {
    return this.patch(taskId, { status: "pending", completed_at: null });
  }

  archive(taskId: string): Promise<Task> {
    return this.patch(taskId, { archived_at: new Date().toISOString() });
  }

  private async patch(taskId: string, patch: Partial<TaskRow>): Promise<Task> {
    const { data, error } = await this.db
      .from("tasks")
      .update(patch)
      .eq("workspace_id", this.workspaceId)
      .eq("id", taskId)
      .is("archived_at", null)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error);
    if (!data) throw new AppError("NOT_FOUND", "Task not found", { recovery: "review" });
    return this.toTask(data);
  }

  private toTask(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      notes: row.notes,
      status: row.status,
      priority: row.priority,
      category: row.category,
      dueDate: row.due_date,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      provenance: {
        providerKey: "elise_native",
        connectionId: this.connectionId,
        externalId: row.id,
      },
    };
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function dbError(error: { code?: string; message: string }): AppError {
  if (error.code === "23514" || error.code === "22P02") {
    return new AppError("VALIDATION_ERROR", "The task data is not valid", { recovery: "review" });
  }
  if (error.code === "42501") return new AppError("PERMISSION_DENIED", "Not allowed");
  return new AppError("PROVIDER_UNAVAILABLE", "Tasks are temporarily unavailable", {
    details: { dbCode: error.code },
  });
}
