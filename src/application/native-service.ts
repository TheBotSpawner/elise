import "server-only";

import { executeToolCall } from "@/core/agents/executor";
import type { ToolDisplay } from "@/core/agents/tools";
import { goalProgress, type Goal, type GoalProgress } from "@/core/capabilities/goals";
import {
  habitProgress,
  progressWindow,
  weekStart,
  type Habit,
  type HabitProgress,
} from "@/core/capabilities/habits";
import { STARTER_LISTS, type NativeList } from "@/core/capabilities/lists";
import type { Note } from "@/core/capabilities/notes";
import { AppError } from "@/core/errors";
import { addDays, todayIn } from "@/core/time";
import { EliseGoalsProvider } from "@/infrastructure/providers/elise-native/goals";
import { EliseHabitsProvider } from "@/infrastructure/providers/elise-native/habits";
import { EliseListsProvider } from "@/infrastructure/providers/elise-native/lists";
import { EliseNotesProvider } from "@/infrastructure/providers/elise-native/notes";

import type { AuthContext } from "./auth-context";
import { createExecutorPorts, runUserTool, toolContext } from "./elise";
import { listSpaces } from "./knowledge-service";

/**
 * My Elise for the UI. Reads come straight from the native repositories (workspace-scoped,
 * RLS); every change goes through the same tool path as Chat (validation, policy, audit,
 * provenance), so UI and Chat always act on the same data in the same way.
 */

const today = (auth: AuthContext) => todayIn(auth.profile.timezone);

/** Only native capability tools can be called from My Elise screens. */
const NATIVE_TOOL = /^(habits|goals|lists|notes)\.[a-zA-Z]+$/;

export async function nativeAction(
  auth: AuthContext,
  tool: string,
  args: unknown,
  key?: string,
): Promise<ToolDisplay | undefined> {
  if (!NATIVE_TOOL.test(tool)) throw new AppError("VALIDATION_ERROR", "Unknown action");
  return (await runUserTool(auth, tool, args, key)).display;
}

/**
 * Habits with their week, in the user's timezone. `week` (any date in it) shows a past week:
 * every day up to today is editable history; the streak is always as of today.
 */
export async function habitsOverview(
  auth: AuthContext,
  week?: string | null,
): Promise<{
  habits: Habit[];
  progress: HabitProgress[];
  week: { start: string; current: boolean };
}> {
  const provider = new EliseHabitsProvider(auth.db, auth.workspaceId, auth.userId);
  const habits = await provider.list({ includeInactive: true });
  const day = today(auth);
  // A past week is shown as of its last day (nothing in it is "future"); never past today.
  const start = week && week <= day ? weekStart(week) : weekStart(day);
  const ref = addDays(start, 6) < day ? addDays(start, 6) : day;
  const entries = await provider.entries(
    habits.map((h) => h.id),
    progressWindow(ref).from,
    progressWindow(day).to,
  );
  return {
    habits,
    progress: habits.map((h) => ({
      ...habitProgress(h, entries, ref),
      streak: habitProgress(h, entries, day).streak,
    })),
    week: { start, current: start === weekStart(day) },
  };
}

export interface GoalView {
  goal: Goal;
  progress: GoalProgress;
  openTasks: string[];
  habits: { name: string; done: number; goal: number }[];
}

export async function goalsOverview(auth: AuthContext) {
  const goals = new EliseGoalsProvider(auth.db, auth.workspaceId, auth.userId);
  const all = await goals.list({ status: "all" });
  const day = today(auth);
  const views: GoalView[] = await Promise.all(
    all.map(async (goal) => {
      const status = await goals.linkedStatus(goal, day);
      return {
        goal,
        progress: goalProgress(goal, status),
        openTasks: status.tasks.open,
        habits: status.habits,
      };
    }),
  );
  const [{ habits }, { data: tasks }] = await Promise.all([
    habitsOverview(auth),
    auth.db
      .from("tasks")
      .select("id, title")
      .eq("workspace_id", auth.workspaceId)
      .is("archived_at", null)
      .in("status", ["pending", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(100),
  ]);
  return {
    goals: views,
    linkable: {
      habits: habits.filter((h) => h.active).map((h) => ({ id: h.id, name: h.name })),
      tasks: (tasks ?? []).map((t) => ({ id: t.id, name: t.title })),
    },
  };
}

const lists = (auth: AuthContext) => new EliseListsProvider(auth.db, auth.workspaceId, auth.userId);

export async function listsOverview(auth: AuthContext) {
  return lists(auth).list();
}

/** The Lists workspace's one read: every list with its items, in column order (ADR-051). */
export async function listsWorkspace(auth: AuthContext): Promise<NativeList[]> {
  await seedStarterLists(auth).catch(() => false); // never blocks the page
  return lists(auth).all();
}

const STARTERS_KEY = "lists.starters_seeded";

/**
 * The starter Lists (🛍️ Compras, 🛩️ Viaje) are created ONCE per user and workspace, then they are
 * ordinary lists: renamed, reordered or deleted like any other, never recreated. The marker is
 * claimed first (unique per workspace/user/key), so concurrent loads can't seed twice, and a
 * starter is skipped when the user already has an equivalent list.
 */
export async function seedStarterLists(auth: AuthContext): Promise<boolean> {
  const { error } = await auth.db.from("user_preferences").insert({
    workspace_id: auth.workspaceId,
    user_id: auth.userId,
    key: STARTERS_KEY,
    value_json: { at: new Date().toISOString() },
    source: "system",
  });
  if (error) return false; // already seeded (23505) or not allowed: nothing to do
  // Its own queries on purpose (not the provider's): Next memoizes identical GETs within a
  // render, and the page reads the lists through the provider right after seeding — a shared
  // query would hand it the pre-seed result.
  const { data: existing } = await auth.db
    .from("lists")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .is("archived_at", null)
    .order("name");
  if (!existing) return false;
  // Someone who already organizes their own lists doesn't get suggestions on top.
  if (existing.length >= 3) return true;
  const has = (match: readonly string[]) =>
    existing.some((l) => {
      const n = l.name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      return match.some((m) => n.includes(m));
    });
  let position = Math.max(0, ...existing.map((l) => l.position ?? 0));
  for (const starter of STARTER_LISTS) {
    if (has(starter.match)) continue;
    position += 1024;
    const base = {
      workspace_id: auth.workspaceId,
      name: auth.profile.locale === "en" ? starter.en : starter.es,
      source: "system" as const,
      created_by_user_id: auth.userId,
    };
    const { error: failed } = await auth.db
      .from("lists")
      .insert({ ...base, position, icon: starter.icon });
    // Before migration 038 there is no position/icon: the list is still created.
    if (failed) await auth.db.from("lists").insert(base);
  }
  return true;
}

/** Column order on the Lists workspace (a UI gesture; ELISE can reorder items, not columns). */
export async function reorderLists(auth: AuthContext, listIds: string[]) {
  return lists(auth).reorderLists(listIds);
}

/** Ordering is a UI gesture with no chat equivalent; it only rewrites positions of one list. */
export async function reorderList(auth: AuthContext, listId: string, itemIds: string[]) {
  return new EliseListsProvider(auth.db, auth.workspaceId, auth.userId).reorder(listId, itemIds);
}

export async function notesOverview(
  auth: AuthContext,
  query: string | null,
): Promise<{ notes: Note[]; spaces: { id: string; path: string }[] }> {
  const provider = new EliseNotesProvider(auth.db, auth.workspaceId, auth.userId);
  const [notes, spaces] = await Promise.all([
    query ? provider.search(query, 50) : provider.list({ limit: 200 }),
    listSpaces(auth),
  ]);
  return { notes, spaces: spaces.map((s) => ({ id: s.id, path: s.path })) };
}

/**
 * Daily-planning foundation: today's tasks, habit commitments, active goals and free time,
 * gathered through the normal tool path. The planning experience itself comes later.
 */
export async function planningSnapshot(auth: AuthContext) {
  const ports = createExecutorPorts(auth);
  const ctx = toolContext(auth, "system");
  const day = today(auth);
  const [tasks, habits, goals, free] = await Promise.all([
    executeToolCall(ports, ctx, {
      name: "tasks.list",
      args: { status: "open", due: "today", limit: 50 },
    }),
    executeToolCall(ports, ctx, { name: "habits.list", args: {} }),
    executeToolCall(ports, ctx, { name: "goals.list", args: { status: "active" } }),
    executeToolCall(ports, ctx, { name: "calendar.findAvailability", args: { from: day } }),
  ]);
  const display = (o: Awaited<typeof tasks>) => (o.status === "succeeded" ? o.display : undefined);
  return {
    date: day,
    tasks: display(tasks),
    habits: display(habits),
    goals: display(goals),
    availability: display(free),
  };
}
