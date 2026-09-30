import type {
  Goal,
  GoalLink,
  GoalsProvider,
  GoalStatus,
  LinkedStatus,
  LinkType,
  NewGoal,
} from "@/core/capabilities/goals";
import { habitProgress, progressWindow, type EntrySource } from "@/core/capabilities/habits";
import { AppError } from "@/core/errors";
import type { GoalLinkRow, GoalRow } from "@/infrastructure/supabase/database.types";
import type { ServerSupabase } from "@/infrastructure/supabase/server";

import { byNameOrId, check, escapeLike } from "./common";
import { EliseHabitsProvider } from "./habits";

const num = (v: number | null) => (v === null ? null : Number(v));

/** ELISE Goals (Native provider). Links point at existing records; nothing is duplicated. */
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
    const titles = await this.titles(links ?? []);
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
      parentGoalId: r.parent_goal_id,
      completedAt: r.completed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      links: (links ?? [])
        .filter((l) => l.goal_id === r.id && l.resource_type !== "entity")
        .map((l): GoalLink => ({
          id: l.id,
          resourceType: l.resource_type as LinkType,
          resourceId: l.resource_id,
          relationship: l.relationship_type,
          title: titles.get(l.resource_id) ?? null,
        })),
    }));
  }

  /** Display names of linked records (habit name, task/goal/note title). */
  private async titles(links: GoalLinkRow[]) {
    const ids = (type: string) =>
      links.filter((l) => l.resource_type === type).map((l) => l.resource_id);
    const out = new Map<string, string>();
    const load = async (
      table: "habits" | "tasks" | "goals" | "notes",
      column: "name" | "title",
      type: string,
    ) => {
      const list = ids(type);
      if (!list.length) return;
      const { data } = await this.db
        .from(table)
        .select(`id, ${column}`)
        .eq("workspace_id", this.workspaceId)
        .in("id", list);
      for (const row of (data ?? []) as unknown as Record<string, string>[])
        out.set(row.id!, row[column]!);
    };
    await Promise.all([
      load("habits", "name", "habit"),
      load("tasks", "title", "task"),
      load("goals", "title", "goal"),
      load("notes", "title", "note"),
    ]);
    return out;
  }

  async list({ status }: { status: GoalStatus | "all" }) {
    let q = this.db
      .from("goals")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .is("archived_at", null)
      .order("created_at");
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

  async create(g: NewGoal, source: EntrySource) {
    const { data, error } = await this.db
      .from("goals")
      .insert({
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
        parent_goal_id: g.parentGoalId ?? null,
        source,
        created_by_user_id: this.userId,
      })
      .select("*")
      .single();
    check(error, "create the goal");
    return (await this.hydrate([data!]))[0]!;
  }

  async update(id: string, p: Partial<NewGoal> & { status?: GoalStatus }) {
    const set: Record<string, unknown> = {};
    // Keys come from the fixed map below, so this is a partial goal row.
    const map: [keyof typeof p, string][] = [
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
      ["parentGoalId", "parent_goal_id"],
      ["status", "status"],
    ];
    for (const [key, column] of map) if (p[key] !== undefined) set[column] = p[key];
    if (p.status) set.completed_at = p.status === "completed" ? new Date().toISOString() : null;
    const { error } = await this.db
      .from("goals")
      .update(set as Partial<GoalRow>)
      .eq("id", id)
      .eq("workspace_id", this.workspaceId);
    check(error, "update the goal");
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

  async link(
    goalId: string,
    l: { resourceType: LinkType; resourceId: string; relationship: GoalLink["relationship"] },
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

  async linkedStatus(goal: Goal, today: string): Promise<LinkedStatus> {
    const taskIds = goal.links.filter((l) => l.resourceType === "task").map((l) => l.resourceId);
    const habitIds = goal.links.filter((l) => l.resourceType === "habit").map((l) => l.resourceId);
    const [{ data: tasks }, habits] = await Promise.all([
      taskIds.length
        ? this.db
            .from("tasks")
            .select("title, status")
            .eq("workspace_id", this.workspaceId)
            .in("id", taskIds)
            .is("archived_at", null)
        : Promise.resolve({ data: [] as { title: string; status: string }[] }),
      habitIds.length ? this.habitsThisWeek(habitIds, today) : Promise.resolve([]),
    ]);
    const live = (tasks ?? []).filter((t) => t.status !== "cancelled");
    return {
      tasks: {
        total: live.length,
        completed: live.filter((t) => t.status === "completed").length,
        open: live.filter((t) => t.status !== "completed").map((t) => t.title),
      },
      habits,
    };
  }

  private async habitsThisWeek(ids: string[], today: string) {
    const habits = new EliseHabitsProvider(this.db, this.workspaceId, this.userId);
    const all = (await habits.list({ includeInactive: true })).filter((h) => ids.includes(h.id));
    const window = progressWindow(today);
    const entries = await habits.entries(ids, window.from, window.to);
    return all.map((h) => {
      const p = habitProgress(h, entries, today);
      return { name: h.name, done: p.week.done, goal: p.week.goal };
    });
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
}
