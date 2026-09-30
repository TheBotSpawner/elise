import "server-only";

import { executeToolCall } from "@/core/agents/executor";
import type { ToolDisplay } from "@/core/agents/tools";
import { goalProgress, type Goal, type GoalProgress } from "@/core/capabilities/goals";
import {
  habitProgress,
  progressWindow,
  type Habit,
  type HabitProgress,
} from "@/core/capabilities/habits";
import type { NativeList } from "@/core/capabilities/lists";
import type { Note } from "@/core/capabilities/notes";
import { AppError } from "@/core/errors";
import { todayIn } from "@/core/time";
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

export async function habitsOverview(
  auth: AuthContext,
): Promise<{ habits: Habit[]; progress: HabitProgress[] }> {
  const provider = new EliseHabitsProvider(auth.db, auth.workspaceId, auth.userId);
  const habits = await provider.list({ includeInactive: true });
  const day = today(auth);
  const window = progressWindow(day);
  const entries = await provider.entries(
    habits.map((h) => h.id),
    window.from,
    window.to,
  );
  return { habits, progress: habits.map((h) => habitProgress(h, entries, day)) };
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

export async function listsOverview(auth: AuthContext) {
  return new EliseListsProvider(auth.db, auth.workspaceId, auth.userId).list();
}

export async function listDetail(auth: AuthContext, id: string): Promise<NativeList | null> {
  return new EliseListsProvider(auth.db, auth.workspaceId, auth.userId).get(id);
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
