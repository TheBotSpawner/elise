import {
  matchesTaskSearch,
  taskCapabilities,
  type CreateTaskInput,
  type Task,
  type TaskLabel,
  type TaskLabelsInput,
  type TaskProvider,
  type TaskQuery,
  type TaskWriteMeta,
  type UpdateTaskInput,
} from "@/core/capabilities/tasks";
import { AppError } from "@/core/errors";
import { makeExternalRef, parseExternalRef } from "@/core/providers/refs";
import {
  nextAfterCompletion,
  nextOccurrence,
  parseRRule,
  toRRule,
  type Repeat,
} from "@/core/tasks/recurrence";
import { addDays, todayIn } from "@/core/time";
import type { TaskEnrichmentRow, LabelRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import type { RecurrenceTemplate, TaskRecurrenceStore } from "./task-recurrence";

/**
 * ELISE's own layer on top of every task provider (ADR-050): labels, and priority for providers
 * that have none (Google). It is NOT a copy: a provider task gets an enrichment row keyed by its
 * identity (connection + provider task id) holding only what the provider can't store. Title,
 * status, due date, notes, parent and list are always read from and written to the provider.
 */

/** PostgREST/Postgres "relation doesn't exist": the migration isn't applied yet. */
const missingTable = (code?: string) => code === "PGRST205" || code === "42P01";

const NOT_READY = () =>
  new AppError("CAPABILITY_UNAVAILABLE", "Labels need the latest ELISE database update", {
    recovery: "review",
  });

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

interface Snapshot {
  labels: LabelRow[];
  enrichments: TaskEnrichmentRow[];
  assignments: { label_id: string; task_id: string | null; enrichment_id: string | null }[];
}

export class TaskEnrichmentStore {
  private snap: Promise<Snapshot | null> | null = null;

  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
  ) {}

  /**
   * Three workspace-scoped reads, shared by every provider of this request (no per-task or
   * per-label queries). ponytail: whole-workspace reads; page by task ids if label use grows large.
   */
  private read(): Promise<Snapshot | null> {
    this.snap ??= (async () => {
      const [labels, enrichments, assignments] = await Promise.all([
        this.db.from("labels").select("*").eq("workspace_id", this.workspaceId),
        this.db.from("task_enrichments").select("*").eq("workspace_id", this.workspaceId),
        this.db
          .from("label_assignments")
          .select("label_id, task_id, enrichment_id")
          .eq("workspace_id", this.workspaceId),
      ]);
      const failed = labels.error ?? enrichments.error ?? assignments.error;
      if (failed) {
        if (missingTable(failed.code)) return null; // not migrated: tasks still work, unenriched
        throw new AppError("PROVIDER_UNAVAILABLE", "Task labels are temporarily unavailable");
      }
      return {
        labels: labels.data ?? [],
        enrichments: enrichments.data ?? [],
        assignments: assignments.data ?? [],
      };
    })();
    return this.snap;
  }

  private invalidate() {
    this.snap = null;
  }

  /** Labels and ELISE priority merged into the provider's tasks (provider fields untouched). */
  async apply(tasks: Task[]): Promise<Task[]> {
    const snap = tasks.length ? await this.read() : null;
    if (!snap) return tasks.map((t) => ({ ...t, labels: t.labels ?? [] }));
    const labelName = new Map(snap.labels.map((l) => [l.id, l.name]));
    const enrichment = new Map(
      snap.enrichments.map((e) => [`${e.connection_id}|${e.provider_task_id}`, e]),
    );
    const byTask = new Map<string, string[]>();
    for (const a of snap.assignments) {
      const key = a.task_id ?? `e:${a.enrichment_id}`;
      const name = labelName.get(a.label_id);
      if (name) byTask.set(key, [...(byTask.get(key) ?? []), name]);
    }
    return tasks.map((t) => {
      if (t.provenance.providerKey === "elise_native")
        return { ...t, labels: (byTask.get(t.id) ?? []).sort() };
      const e = enrichment.get(`${t.provenance.connectionId}|${t.provenance.externalId}`);
      return {
        ...t,
        priority: e?.priority ?? t.priority,
        labels: e ? (byTask.get(`e:${e.id}`) ?? []).sort() : [],
      };
    });
  }

  /** The enrichment row of a provider task, created on first use (identity only). */
  private async enrichmentFor(task: Task): Promise<TaskEnrichmentRow> {
    const { data, error } = await this.db
      .from("task_enrichments")
      .upsert(
        {
          workspace_id: this.workspaceId,
          provider_key: task.provenance.providerKey,
          connection_id: task.provenance.connectionId,
          // The provider's own list id (not ELISE's ref), for cleanup checks.
          provider_list_id: task.provenance.listId
            ? (parseExternalRef(task.provenance.listId)?.parts[1] ?? task.provenance.listId)
            : "",
          provider_task_id: task.provenance.externalId,
        },
        { onConflict: "workspace_id,connection_id,provider_task_id" },
      )
      .select("*")
      .single();
    if (error) throw missingTable(error.code) ? NOT_READY() : dbError(error);
    return data;
  }

  /** ELISE priority on a task its provider can't prioritize. */
  async setPriority(task: Task, priority: Task["priority"]) {
    const row = await this.enrichmentFor(task);
    const { error } = await this.db
      .from("task_enrichments")
      .update({ priority })
      .eq("workspace_id", this.workspaceId)
      .eq("id", row.id);
    if (error) throw dbError(error);
    this.invalidate();
  }

  /** Label ids for these names, creating the missing ones (case-insensitive, one per name). */
  private async ensureLabels(names: string[]): Promise<string[]> {
    const snap = await this.read();
    if (!snap) throw NOT_READY();
    const ids: string[] = [];
    for (const name of [...new Set(names.map((n) => n.trim()))]) {
      const existing = snap.labels.find((l) => norm(l.name) === norm(name));
      if (existing) {
        ids.push(existing.id);
        continue;
      }
      const { data, error } = await this.db
        .from("labels")
        .insert({ workspace_id: this.workspaceId, name })
        .select("*")
        .single();
      if (error) throw dbError(error);
      snap.labels.push(data);
      ids.push(data.id);
    }
    return ids;
  }

  async changeLabels(task: Task, add: string[] = [], remove: string[] = []) {
    if (!add.length && !remove.length) return;
    const snap = await this.read();
    if (!snap) throw NOT_READY();
    // A native task is labelled directly; a provider task through its enrichment row.
    const column =
      task.provenance.providerKey === "elise_native"
        ? ("task_id" as const)
        : ("enrichment_id" as const);
    const value = column === "task_id" ? task.id : (await this.enrichmentFor(task)).id;
    if (add.length) {
      const ids = await this.ensureLabels(add);
      const already = new Set(
        snap.assignments.filter((a) => a[column] === value).map((a) => a.label_id),
      );
      const rows = ids
        .filter((id) => !already.has(id))
        .map((label_id) => ({
          workspace_id: this.workspaceId,
          label_id,
          task_id: column === "task_id" ? value : null,
          enrichment_id: column === "enrichment_id" ? value : null,
        }));
      if (rows.length) {
        const { error } = await this.db.from("label_assignments").insert(rows);
        if (error) throw dbError(error);
      }
    }
    if (remove.length) {
      const ids = snap.labels
        .filter((l) => remove.some((r) => norm(r) === norm(l.name)))
        .map((l) => l.id);
      if (ids.length) {
        const { error } = await this.db
          .from("label_assignments")
          .delete()
          .eq("workspace_id", this.workspaceId)
          .in("label_id", ids)
          .eq(column, value);
        if (error) throw dbError(error);
      }
    }
    this.invalidate();
  }

  /** The provider task is gone: its ELISE metadata goes with it (labels cascade). */
  async forget(connectionId: string, providerTaskId: string) {
    const { error } = await this.db
      .from("task_enrichments")
      .delete()
      .eq("workspace_id", this.workspaceId)
      .eq("connection_id", connectionId)
      .eq("provider_task_id", providerTaskId);
    if (error && !missingTable(error.code)) throw dbError(error);
    this.invalidate();
  }

  /** Enrichments of a connection whose task wasn't in a full read of its open tasks. */
  async orphans(connectionId: string, seen: Set<string>): Promise<TaskEnrichmentRow[]> {
    const snap = await this.read().catch(() => null);
    return (snap?.enrichments ?? []).filter(
      (e) => e.connection_id === connectionId && !seen.has(e.provider_task_id),
    );
  }

  async manage(input: TaskLabelsInput, openTasks: () => Promise<Task[]>): Promise<TaskLabel[]> {
    const snap = await this.read();
    if (!snap) {
      if (input.action === "list") return [];
      throw NOT_READY();
    }
    const find = (name?: string) =>
      name ? snap.labels.find((l) => norm(l.name) === norm(name)) : undefined;
    if (input.action !== "list" && !input.name)
      throw new AppError("VALIDATION_ERROR", "Which label?", { recovery: "review" });
    if (input.action === "create") await this.ensureLabels([input.name!]);
    if (input.action === "rename" || input.action === "delete") {
      const label = find(input.name);
      if (!label)
        throw new AppError("NOT_FOUND", `There's no label called "${input.name}"`, {
          recovery: "review",
        });
      const { error } =
        input.action === "delete"
          ? await this.db
              .from("labels")
              .delete()
              .eq("workspace_id", this.workspaceId)
              .eq("id", label.id)
          : await this.db
              .from("labels")
              .update({ name: input.newName ?? label.name })
              .eq("workspace_id", this.workspaceId)
              .eq("id", label.id);
      if (error) throw dbError(error);
    }
    this.invalidate();
    const fresh = await this.read();
    const counts = new Map<string, number>();
    for (const t of await openTasks())
      for (const l of t.labels ?? []) counts.set(norm(l), (counts.get(norm(l)) ?? 0) + 1);
    return (fresh?.labels ?? [])
      .map((l) => ({ name: l.name, count: counts.get(norm(l.name)) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/**
 * Any TaskProvider with ELISE's enrichment on top. Filters that depend on ELISE data (search over
 * labels, priority, label) run after merging, so they mean the same for every provider.
 */
export class EnrichedTaskProvider implements TaskProvider {
  private readonly caps;

  constructor(
    private readonly inner: TaskProvider,
    private readonly store: TaskEnrichmentStore,
    private readonly providerKey: string,
    private readonly connectionId: string,
    /** Recurring series (ADR-115); absent where they aren't wired (tests, scripts). */
    private readonly series?: TaskRecurrenceStore,
  ) {
    this.caps = taskCapabilities(providerKey);
  }

  /** ELISE's layers over the provider's tasks: labels/priority, then the series they belong to. */
  private async decorate(tasks: Task[]): Promise<Task[]> {
    const enriched = await this.store.apply(tasks);
    return this.series ? this.series.apply(enriched) : enriched;
  }

  listLists() {
    return this.inner.listLists();
  }

  get createList() {
    return this.inner.createList?.bind(this.inner);
  }

  async list(query: TaskQuery): Promise<Task[]> {
    const filtered = Boolean(query.search || query.priority || query.label);
    const tasks = await this.decorate(
      await this.inner.list(
        filtered
          ? { ...query, search: undefined, priority: undefined, label: undefined, limit: 500 }
          : query,
      ),
    );
    if (!filtered) {
      if (query.status === "open" && !query.dueFrom && !query.dueTo && !query.noDueDate) {
        this.sweep(tasks);
        this.catchUp(tasks);
      }
      return tasks;
    }
    const label = query.label ? norm(query.label) : null;
    return tasks
      .filter(
        (t) =>
          (!query.search || matchesTaskSearch(t, query.search)) &&
          (!query.priority || t.priority === query.priority) &&
          (!label || (t.labels ?? []).some((l) => norm(l) === label)),
      )
      .slice(0, query.limit);
  }

  /**
   * A full read of a provider's open tasks shows which enriched tasks are gone or done. A few of
   * those are checked at the provider each read, and the deleted ones lose their ELISE metadata
   * (completed ones keep it). Fire-and-forget: never slows the read.
   */
  private sweep(open: Task[]) {
    if (this.providerKey === "elise_native") return;
    const seen = new Set(open.map((t) => t.provenance.externalId));
    void this.store
      .orphans(this.connectionId, seen)
      .then((rows) =>
        Promise.all(
          rows.slice(0, 5).map(async (row) => {
            const ref = makeExternalRef(
              row.connection_id,
              "task",
              row.provider_list_id,
              row.provider_task_id,
            );
            const task = await this.inner.get(ref).catch(() => undefined);
            if (task === null) await this.store.forget(row.connection_id, row.provider_task_id);
          }),
        ),
      )
      .catch(() => undefined);
  }

  /**
   * A series' live task missing from a full read of open tasks was completed (or deleted)
   * outside ELISE — in Google Tasks, say. A few are checked per read; completed ones advance.
   * Fire-and-forget, like the sweep.
   */
  private catchUp(open: Task[]) {
    if (!this.series) return;
    const seen = new Set(open.map((t) => t.provenance.externalId));
    void this.series
      .missing(this.connectionId, seen)
      .then((rows) =>
        Promise.all(
          rows.slice(0, 3).map(async (row) => {
            const ref =
              this.providerKey === "elise_native"
                ? row.current_task_id
                : makeExternalRef(
                    row.connection_id,
                    "task",
                    parseExternalRef(row.provider_list_id)?.parts[1] ?? row.provider_list_id,
                    row.current_task_id,
                  );
            const task = await this.inner.get(ref).catch(() => undefined);
            if (task === null) await this.series!.end(row.id);
            else if (task?.status === "completed") await this.advance(task);
          }),
        ),
      )
      .catch(() => undefined);
  }

  /** What the next occurrence copies from this one. */
  private template(task: Task): RecurrenceTemplate {
    return {
      title: task.title,
      description: task.description,
      priority: task.priority,
      labels: task.labels ?? [],
    };
  }

  /** A series from this task on; a task without a date starts at the rule's first date. */
  private async startSeries(task: Task, repeat: Repeat): Promise<Task> {
    if (!this.series)
      throw new AppError("CAPABILITY_UNAVAILABLE", "Recurring tasks aren't available here", {
        recovery: "review",
      });
    if (task.parentId)
      throw new AppError("VALIDATION_ERROR", "A subtask can't repeat; make the main task repeat", {
        recovery: "review",
      });
    const today = todayIn(this.series.timezone);
    let dated = task;
    if (!task.dueDate) {
      const first = nextOccurrence(repeat, today, addDays(today, -1)) ?? today;
      dated = await this.inner.update({ taskId: task.id, dueDate: first });
    }
    await this.series.start(dated, toRRule(repeat), dated.dueDate!, this.template(dated));
    return dated;
  }

  /**
   * The live occurrence was completed: create the next one (never a batch). The claim makes it
   * idempotent; if creating fails, the series points back at the completed task.
   */
  private async advance(done: Task): Promise<Task["recurrence"]> {
    const row = this.series ? await this.series.forTask(done) : null;
    if (!row || !this.series) return undefined;
    let rule: Repeat;
    try {
      rule = parseRRule(row.rrule);
    } catch {
      return undefined;
    }
    const next = nextAfterCompletion(
      rule,
      row.dtstart,
      row.occurrence_date,
      todayIn(row.timezone),
      row.occurrences,
    );
    if (!next) {
      await this.series.end(row.id);
      return { rrule: row.rrule, summary: "", next: null };
    }
    if (!(await this.series.claim(row, next))) return undefined;
    const t = row.template as Partial<RecurrenceTemplate>;
    try {
      const created = await this.create(
        {
          title: t.title || done.title,
          ...(t.description ? { description: t.description } : {}),
          ...(t.priority ? { priority: t.priority } : {}),
          ...(t.labels?.length ? { labels: t.labels } : {}),
          ...(row.provider_list_id ? { list: row.provider_list_id } : {}),
          dueDate: next,
        },
        { userId: row.created_by, source: "system" },
      );
      await this.series.settle(row.id, created.provenance.externalId);
      return { rrule: row.rrule, summary: "", next };
    } catch (error) {
      await this.series.revert(row);
      throw error;
    }
  }

  async get(taskId: string): Promise<Task | null> {
    const task = await this.inner.get(taskId);
    if (!task) return null;
    return (await this.decorate([task]))[0]!;
  }

  async create(input: CreateTaskInput, meta: TaskWriteMeta): Promise<Task> {
    const { labels, priority, repeat, ...rest } = input;
    const elisePriority = this.caps.priority === "elise" ? priority : undefined;
    let task = await this.inner.create(
      { ...rest, ...(elisePriority ? {} : priority ? { priority } : {}) },
      meta,
    );
    if (elisePriority) await this.store.setPriority(task, elisePriority);
    if (labels?.length) await this.store.changeLabels(task, labels);
    if (repeat) task = await this.startSeries((await this.store.apply([task]))[0]!, repeat);
    [task] = await this.decorate([task]);
    return task!;
  }

  async update(input: UpdateTaskInput): Promise<Task> {
    const { addLabels, removeLabels, priority, repeat, repeatScope, ...rest } = input;
    const elisePriority = this.caps.priority === "elise" && priority !== undefined;
    const providerFields = Object.keys(rest).filter((k) => k !== "taskId").length > 0;
    let task =
      providerFields || (!elisePriority && priority !== undefined)
        ? await this.inner.update({ ...rest, ...(elisePriority ? {} : { priority }) })
        : await this.inner.get(input.taskId);
    if (!task) throw new AppError("NOT_FOUND", "Task not found", { recovery: "review" });
    if (elisePriority) await this.store.setPriority(task, priority ?? null);
    await this.store.changeLabels(task, addLabels, removeLabels);
    [task] = await this.store.apply([task]);
    task = await this.reshapeSeries(task!, repeat, repeatScope);
    [task] = await this.decorate([task]);
    return task!;
  }

  /**
   * Editing a recurring task (ADR-115): "this" changes only this occurrence; "all" changes the
   * series (rule and what next occurrences copy); "following" ends the series here and starts a
   * new one from this occurrence, so what happened before keeps its old rule.
   */
  private async reshapeSeries(
    task: Task,
    repeat: Repeat | null | undefined,
    scope: "this" | "following" | "all" | undefined,
  ): Promise<Task> {
    if (!this.series || (repeat === undefined && (!scope || scope === "this"))) return task;
    const row = await this.series.forTask(task);
    if (!row) return repeat ? this.startSeries(task, repeat) : task;
    if (repeat === null) {
      await this.series.end(row.id);
      return task;
    }
    const effective = scope ?? "all";
    if (effective === "this") return task;
    const anchor = task.dueDate ?? row.occurrence_date;
    if (effective === "following") {
      await this.series.end(row.id);
      await this.series.start(
        task,
        repeat ? toRRule(repeat) : row.rrule,
        anchor,
        this.template(task),
      );
      return task;
    }
    await this.series.change(row.id, {
      template: this.template(task),
      ...(repeat ? { rrule: toRRule(repeat), dtstart: anchor, occurrence_date: anchor } : {}),
    });
    return task;
  }

  async complete(taskId: string) {
    const done = (await this.store.apply([await this.inner.complete(taskId)]))[0]!;
    const recurrence = await this.advance(done);
    const [task] = await this.decorate([done]);
    return recurrence ? { ...task!, recurrence: { ...recurrence, next: recurrence.next } } : task!;
  }

  async reopen(taskId: string) {
    return (await this.decorate([await this.inner.reopen(taskId)]))[0]!;
  }

  async archive(taskId: string): Promise<Task> {
    const task = await this.inner.archive(taskId);
    // Deleting the live occurrence ends its series (no orphan series creating tasks later).
    const row = this.series ? await this.series.forTask(task).catch(() => null) : null;
    if (row) await this.series!.end(row.id);
    // A provider deletes for good: its ELISE metadata goes too. Native tasks are only archived.
    if (task.provenance.providerKey !== "elise_native")
      await this.store.forget(task.provenance.connectionId, task.provenance.externalId);
    return task;
  }

  manageLabels(input: TaskLabelsInput) {
    return this.store.manage(input, () => this.list({ status: "open", limit: 500 }));
  }
}

function dbError(error: { code?: string; message: string }): AppError {
  if (error.code === "23505")
    return new AppError("VALIDATION_ERROR", "That label already exists", { recovery: "review" });
  if (error.code === "23514" || error.code === "22P02")
    return new AppError("VALIDATION_ERROR", "The task data is not valid", { recovery: "review" });
  if (error.code === "42501") return new AppError("PERMISSION_DENIED", "Not allowed");
  return new AppError("PROVIDER_UNAVAILABLE", "Task labels are temporarily unavailable", {
    details: { dbCode: error.code },
  });
}
