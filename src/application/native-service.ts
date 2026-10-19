import "server-only";

import { executeToolCall } from "@/core/agents/executor";
import type { ToolDisplay } from "@/core/agents/tools";
import { drivesProgress } from "@/core/capabilities/goals";
import {
  habitProgress,
  progressWindow,
  weekStart,
  type Habit,
  type HabitEntry,
  type HabitProgress,
} from "@/core/capabilities/habits";
import { STARTER_LISTS, type NativeList } from "@/core/capabilities/lists";
import type { Note, NoteTag } from "@/core/capabilities/notes";
import { AppError } from "@/core/errors";
import type { GoalDetail, GoalSnapshot, VisionSummary } from "@/core/goals/analytics";
import {
  daysIn,
  entriesWindow,
  HABIT_VIEWS,
  habitRange,
  type HabitRange,
  type HabitView,
} from "@/core/habits/analytics";
import { addDays, isIsoDate, todayIn } from "@/core/time";
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

// ── Goals workspace (ADR-055) ────────────────────────────────────────────────

export interface GoalsWorkspace {
  goals: GoalSnapshot[];
  visions: VisionSummary[];
  /** Selectors for the forms: active habits and the areas already in use. */
  habits: { id: string; name: string; icon: string | null }[];
  areas: string[];
  today: string;
  archived: boolean;
}

/**
 * The Goals screen in one light read: every goal (archived only when asked) with progress and
 * health from the same tool Chat uses, in a fixed number of queries and without history. The
 * history of a goal loads when its detail opens.
 */
export async function goalsWorkspace(
  auth: AuthContext,
  archived: boolean,
): Promise<GoalsWorkspace> {
  const [display, habits] = await Promise.all([
    nativeAction(auth, "goals.list", { status: archived ? "archived" : "all" }),
    new EliseHabitsProvider(auth.db, auth.workspaceId, auth.userId).list({
      includeInactive: false,
    }),
  ]);
  const goals = display?.kind === "goals" ? display.goals : [];
  const visions = display?.kind === "goals" ? (display.visions ?? []) : [];
  return {
    goals,
    visions,
    habits: habits.map((h) => ({ id: h.id, name: h.name, icon: h.icon })),
    areas: [
      ...new Set(
        [...goals.map((g) => g.goal.area), ...visions.map((v) => v.vision.area)].filter(
          (a): a is string => Boolean(a),
        ),
      ),
    ].sort(),
    today: today(auth),
    archived,
  };
}

/** One goal in depth (history, Visions, related goals): the same read as goals.getProgress. */
export async function goalDetail(auth: AuthContext, goalId: string): Promise<GoalDetail | null> {
  const d = await nativeAction(auth, "goals.getProgress", { goal: goalId });
  return d?.kind === "goal" ? d.detail : null;
}

/** The goals each habit relates to, and the active goals it could relate to (Habits form). */
export async function habitGoals(auth: AuthContext) {
  const goals = await new EliseGoalsProvider(auth.db, auth.workspaceId, auth.userId)
    .list({ status: "active" })
    .catch(() => []);
  const links: Record<string, { goalId: string; drives: boolean }[]> = {};
  for (const g of goals)
    for (const l of g.links)
      if (l.resourceType === "habit")
        (links[l.resourceId] ??= []).push({ goalId: g.id, drives: drivesProgress(l) });
  return {
    goals: goals.map((g) => ({
      id: g.id,
      title: g.title,
      icon: g.icon ?? null,
      canDrive: g.progressType === "numeric" && g.direction !== "decrease",
    })),
    links,
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
  /** ADR-088: only notes with every one of these tags. */
  tagIds: string[] = [],
): Promise<{
  notes: Note[];
  spaces: { id: string; path: string; general: boolean }[];
  tags: NoteTag[];
}> {
  const provider = new EliseNotesProvider(auth.db, auth.workspaceId, auth.userId);
  const filter = tagIds.length ? tagIds : undefined;
  const [notes, spaces, tags] = await Promise.all([
    query ? provider.search(query, 50, filter) : provider.list({ limit: 200, tagIds: filter }),
    listSpaces(auth),
    provider.listTags(),
  ]);
  return {
    notes,
    spaces: spaces.map((s) => ({ id: s.id, path: s.path, general: Boolean(s.general) })),
    tags,
  };
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

// ── Habits workspace (ADR-053) ───────────────────────────────────────────────

export type HabitStatusFilter = "active" | "paused" | "archived";

export interface HabitsWorkspace {
  habits: Habit[];
  entries: HabitEntry[];
  range: HabitRange;
  today: string;
  status: HabitStatusFilter;
  counts: Record<HabitStatusFilter, number>;
  /** Related goals per habit and the goals it can relate to (ADR-055). */
  goals: Awaited<ReturnType<typeof habitGoals>>;
}

export function parseHabitParams(params: Record<string, string | string[] | undefined>) {
  const one = (k: string) => {
    const v = params[k];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  const view = one("view");
  const status = one("status");
  const date = one("date");
  const from = one("from");
  const to = one("to");
  return {
    view: (HABIT_VIEWS as readonly string[]).includes(view ?? "") ? (view as HabitView) : "week",
    date: date && isIsoDate(date) ? date : null,
    custom:
      from && to && isIsoDate(from) && isIsoDate(to) && from <= to && daysIn({ from, to }) <= 731
        ? { from, to }
        : undefined,
    status: (["active", "paused", "archived"] as const).includes(status as HabitStatusFilter)
      ? (status as HabitStatusFilter)
      : "active",
  };
}

/**
 * The Habits screen: habits of one status and the check-ins its range needs — the range, the
 * previous equal range (comparison) and 26 weeks for streaks — never the full history.
 * Every number is then computed by `core/habits/analytics` (the same code Chat uses).
 */
export async function habitsWorkspace(
  auth: AuthContext,
  q: ReturnType<typeof parseHabitParams>,
): Promise<HabitsWorkspace> {
  const provider = new EliseHabitsProvider(auth.db, auth.workspaceId, auth.userId);
  const day = today(auth);
  // Pauses with an end resume on their day, before anything is shown.
  const live = await provider.list({ includeInactive: true });
  for (const h of live.filter((x) => !x.active && x.pausedUntil && x.pausedUntil <= day))
    await provider.update(h.id, { active: true });
  const [all, archived] = await Promise.all([
    provider.list({ includeInactive: true }),
    provider.list({ includeInactive: true, archived: true }),
  ]);
  const habits =
    q.status === "archived"
      ? archived
      : all.filter((h) => (q.status === "paused" ? !h.active : h.active));
  const range = habitRange(q.view, q.date ?? day, q.custom);
  const window = entriesWindow(range, day);
  const [entries, goals] = await Promise.all([
    provider.entries(
      habits.map((h) => h.id),
      window.from,
      window.to,
    ),
    habitGoals(auth),
  ]);
  return {
    habits,
    entries,
    range,
    today: day,
    status: q.status,
    counts: {
      active: all.filter((h) => h.active).length,
      paused: all.filter((h) => !h.active).length,
      archived: archived.length,
    },
    goals,
  };
}

/** One habit's full history (detail: longest streak, recent history). */
export async function habitHistory(auth: AuthContext, habitId: string): Promise<HabitEntry[]> {
  const provider = new EliseHabitsProvider(auth.db, auth.workspaceId, auth.userId);
  return provider.entries([habitId], "1970-01-01", today(auth));
}

/** Every check-in as CSV (habit, date, value, unit, status, notes). */
export async function habitsCsv(auth: AuthContext): Promise<string> {
  const provider = new EliseHabitsProvider(auth.db, auth.workspaceId, auth.userId);
  const habits = [
    ...(await provider.list({ includeInactive: true })),
    ...(await provider.list({ includeInactive: true, archived: true })),
  ];
  const entries = await provider.entries(
    habits.map((h) => h.id),
    "1970-01-01",
    today(auth),
  );
  const name = new Map(habits.map((h) => [h.id, h]));
  const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = entries
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) =>
      [
        name.get(e.habitId)?.name ?? "",
        e.date,
        String(e.value),
        name.get(e.habitId)?.unit ?? "",
        e.status,
        e.notes ?? "",
      ]
        .map(cell)
        .join(","),
    );
  return ["habit,date,value,unit,status,notes", ...rows].join("\n");
}
