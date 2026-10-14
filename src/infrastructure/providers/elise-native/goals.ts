import {
  drivesProgress,
  isGoalIcon,
  type Goal,
  type GoalLink,
  type GoalPatch,
  type GoalsProvider,
  type GoalStatus,
  type LinkedStatus,
  type LinkType,
  type NewGoal,
  type NewVision,
  type ProgressEvent,
  type ProgressSource,
  type Relationship,
  type Vision,
  type VisionStatus,
} from "@/core/capabilities/goals";
import { habitProgress, weekStart, type EntrySource } from "@/core/capabilities/habits";
import { AppError } from "@/core/errors";
import { habitContribution } from "@/core/goals/analytics";
import { todayIn } from "@/core/time";
import type {
  GoalLinkRow,
  GoalProgressEventRow,
  GoalRow,
  VisionRow,
} from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import { byNameOrId, check, escapeLike, needsUpdate, notMigrated } from "./common";
import { EliseHabitsProvider } from "./habits";

const num = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v));
const emoji = (v: string | null | undefined) => (v && isGoalIcon(v) ? v : null);

/** Columns added by migration 042 (ADR-055): dropped from writes on an older database. */
const V2_COLUMNS = ["icon", "area", "period_start", "period_end", "currency"] as const;

function withoutV2(row: Record<string, unknown>) {
  const rest = { ...row };
  for (const c of V2_COLUMNS) delete rest[c];
  return rest;
}

const toVision = (r: VisionRow): Vision => ({
  id: r.id,
  title: r.title,
  description: r.description,
  icon: emoji(r.icon),
  area: r.area,
  status: r.status,
  achievedAt: r.achieved_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toEvent = (r: GoalProgressEventRow): ProgressEvent => ({
  id: r.id,
  goalId: r.goal_id,
  previousValue: num(r.previous_value),
  newValue: num(r.new_value),
  sourceType: r.source_type,
  sourceId: r.source_id,
  note: r.note,
  occurredAt: r.occurred_at,
});

/**
 * ELISE Goals and Visions (Native provider). Links point at existing records; nothing is
 * duplicated. Every query is scoped to the workspace explicitly (RLS also applies). Before
 * migration 042 it reads and writes the v1 columns only, and Visions/history are empty.
 */
export class EliseGoalsProvider implements GoalsProvider {
  constructor(
    private readonly db: ServerSupabase,
    private readonly workspaceId: string,
    private readonly userId: string,
  ) {}

  private async hydrate(rows: GoalRow[]): Promise<Goal[]> {
    if (!rows.length) return [];
    const { data: links } = await this.db
      .from("goal_links")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .in(
        "goal_id",
        rows.map((r) => r.id),
      );
    const live = (links ?? []).filter((l) => l.resource_type !== "entity");
    const names = await this.names(live);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      targetDate: r.target_date,
      progressType: r.progress_type,
      progressMode: r.progress_mode,
      startValue: num(r.start_value),
      currentValue: num(r.current_value),
      targetValue: num(r.target_value),
      direction: r.direction,
      metric: r.metric,
      currency: r.currency ?? null,
      icon: emoji(r.icon),
      area: r.area ?? null,
      periodStart: r.period_start ?? null,
      periodEnd: r.period_end ?? null,
      parentGoalId: r.parent_goal_id,
      completedAt: r.completed_at,
      archived: r.archived_at !== null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      links: live
        .filter((l) => l.goal_id === r.id)
        .map((l): GoalLink => ({
          id: l.id,
          resourceType: l.resource_type as LinkType,
          resourceId: l.resource_id,
          relationship: l.relationship_type,
          title: names.get(l.resource_id)?.title ?? null,
          icon: names.get(l.resource_id)?.icon ?? null,
        })),
    }));
  }

  /** Display names (and icons) of linked records. */
  private async names(links: GoalLinkRow[]) {
    const ids = (type: string) =>
      links.filter((l) => l.resource_type === type).map((l) => l.resource_id);
    const out = new Map<string, { title: string; icon: string | null }>();
    const load = async (
      table: "habits" | "tasks" | "goals" | "notes" | "visions",
      column: "name" | "title",
      type: string,
    ) => {
      const list = ids(type);
      if (!list.length) return;
      // `*` so the icon comes along where the table has one (habits keep it in metadata).
      const { data } = await this.db
        .from(table)
        .select("*")
        .eq("workspace_id", this.workspaceId)
        .in("id", list);
      for (const row of (data ?? []) as unknown as Record<string, unknown>[]) {
        const meta = row.metadata as { icon?: string } | undefined;
        out.set(row.id as string, {
          title: row[column] as string,
          icon: emoji((row.icon as string | undefined) ?? meta?.icon),
        });
      }
    };
    await Promise.all([
      load("habits", "name", "habit"),
      load("tasks", "title", "task"),
      load("goals", "title", "goal"),
      load("notes", "title", "note"),
      load("visions", "title", "vision"),
    ]);
    return out;
  }

  async list({ status, archived = false }: { status: GoalStatus | "all"; archived?: boolean }) {
    let q = this.db
      .from("goals")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .order("created_at");
    q = archived ? q.not("archived_at", "is", null) : q.is("archived_at", null);
    if (status !== "all") q = q.eq("status", status);
    const { data, error } = await q;
    check(error, "load goals");
    return this.hydrate(data ?? []);
  }

  async find(ref: string) {
    return byNameOrId(await this.list({ status: "all" }), ref, (g) => g.title);
  }

  private async one(id: string) {
    const { data } = await this.db
      .from("goals")
      .select("*")
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .maybeSingle();
    if (!data) throw new AppError("NOT_FOUND", "Goal not found");
    return (await this.hydrate([data]))[0]!;
  }

  /** Writes v2 columns, or only the v1 ones while migration 042 isn't applied. */
  private async write(
    run: (row: Record<string, unknown>) => PromiseLike<{
      data: GoalRow | null;
      error: { message: string; code?: string } | null;
    }>,
    row: Record<string, unknown>,
    what: string,
  ) {
    let { data, error } = await run(row);
    if (error && notMigrated(error.code)) ({ data, error } = await run(withoutV2(row)));
    if (error?.code === "23514" && /circular|deep/.test(error.message))
      throw new AppError("VALIDATION_ERROR", "A goal can't contribute to itself, even indirectly", {
        recovery: "review",
      });
    check(error, what);
    return data;
  }

  async create(g: NewGoal, source: EntrySource) {
    const data = await this.write(
      (row) =>
        this.db
          .from("goals")
          .insert(row as never)
          .select("*")
          .single(),
      {
        workspace_id: this.workspaceId,
        title: g.title,
        description: g.description ?? null,
        target_date: g.targetDate ?? null,
        progress_type: g.progressType,
        progress_mode: g.progressMode,
        start_value: g.startValue ?? null,
        current_value: g.currentValue ?? null,
        target_value: g.targetValue ?? null,
        direction: g.direction ?? "increase",
        metric: g.metric ?? null,
        currency: g.currency ?? null,
        icon: g.icon ?? null,
        area: g.area ?? null,
        period_start: g.periodStart ?? null,
        period_end: g.periodEnd ?? null,
        parent_goal_id: g.parentGoalId ?? null,
        source,
        created_by_user_id: this.userId,
      },
      "create the goal",
    );
    return (await this.hydrate([data!]))[0]!;
  }

  async update(id: string, p: GoalPatch) {
    const set: Record<string, unknown> = {};
    // Keys come from the fixed map below, so this is a partial goal row.
    const map: [keyof GoalPatch, string][] = [
      ["title", "title"],
      ["description", "description"],
      ["targetDate", "target_date"],
      ["progressType", "progress_type"],
      ["progressMode", "progress_mode"],
      ["startValue", "start_value"],
      ["currentValue", "current_value"],
      ["targetValue", "target_value"],
      ["direction", "direction"],
      ["metric", "metric"],
      ["currency", "currency"],
      ["icon", "icon"],
      ["area", "area"],
      ["periodStart", "period_start"],
      ["periodEnd", "period_end"],
      ["parentGoalId", "parent_goal_id"],
      ["status", "status"],
    ];
    for (const [key, column] of map) if (p[key] !== undefined) set[column] = p[key];
    if (p.status) set.completed_at = p.status === "completed" ? new Date().toISOString() : null;
    if (Object.keys(set).length)
      await this.write(
        (row) =>
          this.db
            .from("goals")
            .update(row as Partial<GoalRow>)
            .eq("id", id)
            .eq("workspace_id", this.workspaceId)
            .select("*")
            .maybeSingle(),
        set,
        "update the goal",
      );
    return this.one(id);
  }

  async archive(id: string) {
    await this.db
      .from("goals")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    return this.one(id);
  }

  async unarchive(id: string) {
    await this.db
      .from("goals")
      .update({ archived_at: null })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    return this.one(id);
  }

  async remove(id: string) {
    // Links and history cascade; links pointing at it are cleaned by a trigger (migration 042).
    const { error, count } = await this.db
      .from("goals")
      .delete({ count: "exact" })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    if (error?.code === "42501") throw needsUpdate();
    check(error, "delete the goal");
    if (!count) throw new AppError("NOT_FOUND", "Goal not found");
  }

  async link(
    goalId: string,
    l: { resourceType: LinkType; resourceId: string; relationship: Relationship },
  ) {
    const { error } = await this.db.from("goal_links").upsert(
      {
        workspace_id: this.workspaceId,
        goal_id: goalId,
        resource_type: l.resourceType,
        resource_id: l.resourceId,
        relationship_type: l.relationship,
      },
      { onConflict: "goal_id,resource_type,resource_id" },
    );
    // Before migration 042 the table doesn't accept Visions.
    if (error?.code === "23514" && l.resourceType === "vision") throw needsUpdate();
    if (error?.code === "23505")
      throw new AppError("VALIDATION_ERROR", "These goals are already related", {
        recovery: "review",
      });
    check(error, "link it");
    return this.one(goalId);
  }

  async unlink(goalId: string, l: { resourceType: LinkType; resourceId: string }) {
    await this.db
      .from("goal_links")
      .delete()
      .eq("workspace_id", this.workspaceId)
      .eq("goal_id", goalId)
      .eq("resource_type", l.resourceType)
      .eq("resource_id", l.resourceId);
    return this.one(goalId);
  }

  async linkedStatus(goal: Goal, today: string, timezone = "UTC"): Promise<LinkedStatus> {
    return (await this.linkedStatuses([goal], today, timezone)).get(goal.id)!;
  }

  /**
   * Linked evidence for many goals with a fixed number of queries (the overview never does one
   * query per goal): driving tasks, linked habits' week, and what driving habits added inside
   * each goal's window (its period, or since it was created, up to today).
   */
  async linkedStatuses(
    goals: Goal[],
    today: string,
    timezone = "UTC",
  ): Promise<Map<string, LinkedStatus>> {
    const links = goals.flatMap((g) => g.links.map((l) => ({ goal: g, link: l })));
    const taskIds = [
      ...new Set(
        links
          .filter((x) => x.link.resourceType === "task" && drivesProgress(x.link))
          .map((x) => x.link.resourceId),
      ),
    ];
    const habitIds = [
      ...new Set(
        links.filter((x) => x.link.resourceType === "habit").map((x) => x.link.resourceId),
      ),
    ];
    const windowOf = (g: Goal) => {
      const from = g.periodStart ?? todayIn(timezone, new Date(g.createdAt));
      const end = g.periodEnd && g.periodEnd < today ? g.periodEnd : today;
      return { from, to: end };
    };
    const habitsProvider = new EliseHabitsProvider(this.db, this.workspaceId, this.userId);
    const from = [weekStart(today), ...goals.map((g) => windowOf(g).from)].sort()[0]!;
    const [{ data: tasks }, habits, entries] = await Promise.all([
      taskIds.length
        ? this.db
            .from("tasks")
            .select("id, title, status, completed_at")
            .eq("workspace_id", this.workspaceId)
            .in("id", taskIds)
            .is("archived_at", null)
        : Promise.resolve({
            data: [] as {
              id: string;
              title: string;
              status: string;
              completed_at: string | null;
            }[],
          }),
      habitIds.length ? habitsProvider.list({ includeInactive: true }) : Promise.resolve([]),
      habitIds.length ? habitsProvider.entries(habitIds, from, today) : Promise.resolve([]),
    ]);
    const out = new Map<string, LinkedStatus>();
    for (const goal of goals) {
      const own = goal.links;
      const driving = new Set(
        own.filter((l) => l.resourceType === "task" && drivesProgress(l)).map((l) => l.resourceId),
      );
      const live = (tasks ?? []).filter((t) => driving.has(t.id) && t.status !== "cancelled");
      const counts = goal.progressType === "numeric" && goal.direction !== "decrease";
      const window = windowOf(goal);
      const contributions: { date: string; amount: number }[] = [];
      const linkedHabits = own
        .filter((l) => l.resourceType === "habit")
        .flatMap((l) => {
          const h = habits.find((x) => x.id === l.resourceId);
          if (!h) return [];
          const week = habitProgress(h, entries, today).week;
          const drives = counts && drivesProgress(l);
          const dated = drives ? habitContribution(h, entries, goal.metric, window) : [];
          contributions.push(...dated);
          return [
            {
              id: h.id,
              name: h.name,
              icon: h.icon,
              done: week.done,
              goal: week.goal,
              drives,
              contribution: dated.reduce((s, d) => s + d.amount, 0),
            },
          ];
        });
      for (const t of live)
        if (t.status === "completed" && t.completed_at)
          contributions.push({ date: todayIn(timezone, new Date(t.completed_at)), amount: 1 });
      out.set(goal.id, {
        tasks: {
          total: live.length,
          completed: live.filter((t) => t.status === "completed").length,
          open: live.filter((t) => t.status !== "completed").map((t) => t.title),
        },
        habits: linkedHabits,
        contributions: contributions.sort((a, b) => a.date.localeCompare(b.date)),
      });
    }
    return out;
  }

  async findTasks(ref: string) {
    const byId = /^[0-9a-f-]{36}$/i.test(ref);
    let q = this.db
      .from("tasks")
      .select("id, title")
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .limit(10);
    q = byId ? q.eq("id", ref) : q.ilike("title", `%${escapeLike(ref)}%`);
    const { data } = await q;
    return data ?? [];
  }

  // ── Progress history (append-only) ─────────────────────────────────────────

  async history(goalId: string, limit: number): Promise<ProgressEvent[]> {
    const { data, error } = await this.db
      .from("goal_progress_events")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .eq("goal_id", goalId)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error && notMigrated(error.code)) return [];
    check(error, "load the goal's history");
    return (data ?? []).map(toEvent);
  }

  async record(
    goalId: string,
    e: {
      previousValue: number | null;
      newValue: number | null;
      sourceType: ProgressSource;
      sourceId?: string | null;
      note?: string | null;
    },
  ) {
    const { error } = await this.db.from("goal_progress_events").insert({
      workspace_id: this.workspaceId,
      goal_id: goalId,
      previous_value: e.previousValue,
      new_value: e.newValue,
      source_type: e.sourceType,
      source_id: e.sourceId ?? null,
      note: e.note ?? null,
      created_by_user_id: this.userId,
    });
    // Before migration 042 there is no history: the value itself is still saved.
    if (error && notMigrated(error.code)) return;
    check(error, "record the goal's progress");
  }

  // ── Visions ────────────────────────────────────────────────────────────────

  async listVisions({ includeArchived }: { includeArchived: boolean }) {
    let q = this.db
      .from("visions")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .order("created_at");
    if (!includeArchived) q = q.neq("status", "archived");
    const { data, error } = await q;
    if (error && notMigrated(error.code)) return [];
    check(error, "load visions");
    return (data ?? []).map(toVision);
  }

  async findVision(ref: string) {
    return byNameOrId(await this.listVisions({ includeArchived: true }), ref, (v) => v.title);
  }

  async createVision(v: NewVision, source: EntrySource) {
    const { data, error } = await this.db
      .from("visions")
      .insert({
        workspace_id: this.workspaceId,
        title: v.title,
        description: v.description ?? null,
        icon: v.icon ?? null,
        area: v.area ?? null,
        source,
        created_by_user_id: this.userId,
      })
      .select("*")
      .single();
    if (error && notMigrated(error.code)) throw needsUpdate();
    check(error, "create the Vision");
    return toVision(data!);
  }

  async updateVision(id: string, p: Partial<NewVision> & { status?: VisionStatus }) {
    const { data, error } = await this.db
      .from("visions")
      .update({
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.icon !== undefined ? { icon: p.icon } : {}),
        ...(p.area !== undefined ? { area: p.area } : {}),
        ...(p.status !== undefined
          ? {
              status: p.status,
              achieved_at: p.status === "achieved" ? new Date().toISOString() : null,
            }
          : {}),
      })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId)
      .select("*")
      .maybeSingle();
    if (error && notMigrated(error.code)) throw needsUpdate();
    check(error, "update the Vision");
    if (!data) throw new AppError("NOT_FOUND", "Vision not found");
    return toVision(data);
  }

  async removeVision(id: string) {
    // Its goals stay; only their links to it go (trigger, migration 042).
    const { error, count } = await this.db
      .from("visions")
      .delete({ count: "exact" })
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    if (error && notMigrated(error.code)) throw needsUpdate();
    check(error, "delete the Vision");
    if (!count) throw new AppError("NOT_FOUND", "Vision not found");
  }
}
