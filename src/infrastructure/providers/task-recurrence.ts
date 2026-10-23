import type { Task } from "@/core/capabilities/tasks";
import { AppError } from "@/core/errors";
import { describeRepeat, parseRRule } from "@/core/tasks/recurrence";
import type { TaskRecurrenceRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

/**
 * Recurring task series (ADR-115, migration 066): ELISE's own rows next to the provider's one
 * live occurrence. Every query is scoped to the workspace (defense in depth on top of RLS).
 * Before the migration is applied, reads see no series and starting one says it needs the
 * database update — tasks keep working.
 */

const missingTable = (code?: string) => code === "PGRST205" || code === "42P01";

export interface RecurrenceTemplate {
  title: string;
  description: string | null;
  priority: Task["priority"];
  labels: string[];
}

export class TaskRecurrenceStore {
  private rows: Promise<TaskRecurrenceRow[] | null> | null = null;

  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    readonly userId: string,
    readonly timezone: string,
    private readonly locale: string,
  ) {}

  private active(): Promise<TaskRecurrenceRow[] | null> {
    this.rows ??= (async () => {
      const { data, error } = await this.db
        .from("task_recurrences")
        .select("*")
        .eq("workspace_id", this.workspaceId)
        .eq("status", "active");
      if (error) {
        if (missingTable(error.code)) return null;
        throw new AppError("PROVIDER_UNAVAILABLE", "Recurring tasks are temporarily unavailable");
      }
      return data ?? [];
    })();
    return this.rows;
  }

  private invalidate() {
    this.rows = null;
  }

  private key = (connectionId: string, taskId: string) => `${connectionId}|${taskId}`;

  /** Each task that is a series' live occurrence says so (rule and words). */
  async apply(tasks: Task[]): Promise<Task[]> {
    const rows = tasks.length ? await this.active().catch(() => null) : null;
    if (!rows?.length) return tasks;
    const by = new Map(rows.map((r) => [this.key(r.connection_id, r.current_task_id), r]));
    return tasks.map((t) => {
      const row = by.get(this.key(t.provenance.connectionId, t.provenance.externalId));
      return row ? { ...t, recurrence: { ...t.recurrence, ...this.words(row) } } : t;
    });
  }

  private words(row: TaskRecurrenceRow) {
    let summary = row.rrule;
    try {
      summary = describeRepeat(parseRRule(row.rrule), row.dtstart, this.locale);
    } catch {
      // An rrule this version can't read is shown as stored, never reinterpreted.
    }
    return { rrule: row.rrule, summary };
  }

  async forTask(task: Task): Promise<TaskRecurrenceRow | null> {
    const rows = await this.active();
    return (
      rows?.find(
        (r) =>
          r.connection_id === task.provenance.connectionId &&
          r.current_task_id === task.provenance.externalId,
      ) ?? null
    );
  }

  /** Series of a connection whose live occurrence wasn't in a full read of its open tasks. */
  async missing(connectionId: string, seen: Set<string>) {
    const rows = await this.active().catch(() => null);
    return (rows ?? []).filter(
      (r) =>
        r.connection_id === connectionId &&
        !r.current_task_id.startsWith("pending:") &&
        !seen.has(r.current_task_id),
    );
  }

  async start(
    task: Task,
    rrule: string,
    anchor: string,
    template: RecurrenceTemplate,
  ): Promise<TaskRecurrenceRow> {
    const { data, error } = await this.db
      .from("task_recurrences")
      .insert({
        workspace_id: this.workspaceId,
        created_by: this.userId,
        provider_key: task.provenance.providerKey,
        connection_id: task.provenance.connectionId,
        provider_list_id: task.provenance.listId ?? "",
        current_task_id: task.provenance.externalId,
        rrule,
        dtstart: anchor,
        occurrence_date: anchor,
        timezone: this.timezone,
        template: { ...template },
      })
      .select("*")
      .single();
    if (error)
      throw missingTable(error.code)
        ? new AppError(
            "CAPABILITY_UNAVAILABLE",
            "Recurring tasks need the latest ELISE database update",
            { recovery: "review" },
          )
        : new AppError("INTERNAL_ERROR", "Could not save the repetition", { cause: error });
    this.invalidate();
    return data;
  }

  async change(
    id: string,
    patch: Partial<Pick<TaskRecurrenceRow, "rrule" | "dtstart" | "occurrence_date">> & {
      template?: RecurrenceTemplate;
    },
  ) {
    const { template, ...rest } = patch;
    const { error } = await this.db
      .from("task_recurrences")
      .update({ ...rest, ...(template ? { template: { ...template } } : {}) })
      .eq("workspace_id", this.workspaceId)
      .eq("id", id);
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not update the repetition", { cause: error });
    this.invalidate();
  }

  async end(id: string) {
    const { error } = await this.db
      .from("task_recurrences")
      .update({ status: "ended", ended_at: new Date().toISOString() })
      .eq("workspace_id", this.workspaceId)
      .eq("id", id);
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not end the repetition", { cause: error });
    this.invalidate();
  }

  /**
   * Claims the step to `next` atomically: only the request that still sees the completed task as
   * the live occurrence wins, so two completions (or a retry) never create two next tasks.
   */
  async claim(row: TaskRecurrenceRow, next: string): Promise<boolean> {
    const { data, error } = await this.db
      .from("task_recurrences")
      .update({
        current_task_id: `pending:${next}`,
        occurrence_date: next,
        occurrences: row.occurrences + 1,
      })
      .eq("workspace_id", this.workspaceId)
      .eq("id", row.id)
      .eq("status", "active")
      .eq("current_task_id", row.current_task_id)
      .select("id");
    this.invalidate();
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not advance the repetition", { cause: error });
    return (data ?? []).length === 1;
  }

  async settle(id: string, taskId: string) {
    const { error } = await this.db
      .from("task_recurrences")
      .update({ current_task_id: taskId })
      .eq("workspace_id", this.workspaceId)
      .eq("id", id);
    this.invalidate();
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not advance the repetition", { cause: error });
  }

  /** The next task couldn't be created: the series points at the completed one again. */
  async revert(row: TaskRecurrenceRow) {
    await this.db
      .from("task_recurrences")
      .update({
        current_task_id: row.current_task_id,
        occurrence_date: row.occurrence_date,
        occurrences: row.occurrences,
      })
      .eq("workspace_id", this.workspaceId)
      .eq("id", row.id);
    this.invalidate();
  }
}
