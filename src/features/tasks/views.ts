import {
  inTaskView,
  isOpenTask,
  matchesTaskSearch,
  type Task,
  type TaskList,
  type TaskPriority,
} from "@/core/capabilities/tasks";
import { addDays } from "@/core/time";

/**
 * The Tasks workspace's views (ADR-050): pure presentation over the one unified task read. Views
 * never mutate a provider — a unified sort is display order only (Google keeps its own order).
 */

export const SYSTEM_VIEWS = ["inbox", "today", "upcoming", "overdue", "completed", "all"] as const;
export type SystemView = (typeof SYSTEM_VIEWS)[number];

export type Selection =
  | { kind: "view"; view: SystemView }
  | { kind: "list"; listId: string }
  | { kind: "label"; name: string };

export const SORTS = ["manual", "due", "priority", "created"] as const;
export type SortKey = (typeof SORTS)[number];

export interface TaskFilters {
  source?: string | null;
  priority?: TaskPriority | null;
  label?: string | null;
  /** Narrow by due: within this week (today … +6). */
  thisWeek?: boolean;
}

export interface Group {
  key: string;
  tasks: Task[];
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Inbox = ELISE's Inbox plus each provider's own default list — never merged into one list. */
export const inboxListIds = (lists: TaskList[]) =>
  new Set(lists.filter((l) => l.isDefault).map((l) => l.id));

export function inSelection(task: Task, sel: Selection, today: string, inbox: Set<string>) {
  const open = isOpenTask(task);
  if (sel.kind === "list") return open && task.provenance.listId === sel.listId;
  if (sel.kind === "label")
    return open && (task.labels ?? []).some((l) => l.toLowerCase() === sel.name.toLowerCase());
  switch (sel.view) {
    case "inbox":
      return open && inbox.has(task.provenance.listId ?? "");
    case "today":
      return open && task.dueDate !== null && task.dueDate <= today;
    case "upcoming":
      return open && task.dueDate !== null && task.dueDate > today;
    case "overdue":
      return inTaskView(task, "overdue", today);
    case "completed":
      return task.status === "completed";
    case "all":
      return open;
  }
}

export function applyFilters(tasks: Task[], f: TaskFilters, today: string, search: string) {
  const q = search.trim();
  return tasks.filter(
    (t) =>
      (!f.source || t.provenance.connectionId === f.source) &&
      (!f.priority || t.priority === f.priority) &&
      (!f.label || (t.labels ?? []).some((l) => l.toLowerCase() === f.label!.toLowerCase())) &&
      (!f.thisWeek || (t.dueDate !== null && t.dueDate <= addDays(today, 6))) &&
      (!q || matchesTaskSearch(t, q)),
  );
}

export function sortTasks(tasks: Task[], sort: SortKey): Task[] {
  const due = (t: Task) => t.dueDate ?? "9999-12-31";
  const prio = (t: Task) => PRIORITY_RANK[t.priority ?? ""] ?? 3;
  return [...tasks].sort((a, b) => {
    switch (sort) {
      case "due":
        return due(a).localeCompare(due(b)) || prio(a) - prio(b);
      case "priority":
        return prio(a) - prio(b) || due(a).localeCompare(due(b));
      case "created":
        return b.createdAt.localeCompare(a.createdAt);
      case "manual":
        // The provider's own order (Google `position`), else creation order — never rewritten.
        return (
          (a.position ?? "").localeCompare(b.position ?? "") ||
          a.createdAt.localeCompare(b.createdAt)
        );
    }
  });
}

/** Monday of the week containing `date` (YYYY-MM-DD). */
function weekStart(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 Sunday
  return addDays(date, -((day + 6) % 7));
}

/**
 * Compact grouping per view; empty groups are left out. Today: overdue first, then today.
 * Upcoming: tomorrow / this week / next week / later. Completed: today / this week / earlier.
 */
export function groupTasks(tasks: Task[], sel: Selection, today: string): Group[] {
  const by = (key: (t: Task) => string, order: string[]) => {
    const map = new Map<string, Task[]>(order.map((k) => [k, []]));
    for (const t of tasks) map.get(key(t))?.push(t);
    return [...map.entries()]
      .filter(([, ts]) => ts.length)
      .map(([key, ts]) => ({ key, tasks: ts }));
  };
  if (sel.kind === "view" && sel.view === "today")
    return by((t) => (t.dueDate! < today ? "overdue" : "today"), ["overdue", "today"]);
  if (sel.kind === "view" && sel.view === "upcoming") {
    const thisWeekEnd = addDays(weekStart(today), 6);
    const nextWeekEnd = addDays(thisWeekEnd, 7);
    return by(
      (t) =>
        t.dueDate === addDays(today, 1)
          ? "tomorrow"
          : t.dueDate! <= thisWeekEnd
            ? "thisWeek"
            : t.dueDate! <= nextWeekEnd
              ? "nextWeek"
              : "later",
      ["tomorrow", "thisWeek", "nextWeek", "later"],
    );
  }
  if (sel.kind === "view" && sel.view === "completed") {
    const monday = weekStart(today);
    return by(
      (t) => {
        const d = (t.completedAt ?? "").slice(0, 10);
        return d >= today ? "doneToday" : d >= monday ? "doneThisWeek" : "doneEarlier";
      },
      ["doneToday", "doneThisWeek", "doneEarlier"],
    );
  }
  return [{ key: "all", tasks }];
}

/**
 * Subtasks sit under their parent when both are shown; a subtask whose parent isn't in view
 * stands on its own (never hidden).
 */
export function nest(tasks: Task[]): { task: Task; depth: number }[] {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map<string, Task[]>();
  for (const t of tasks)
    if (t.parentId && ids.has(t.parentId))
      children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  const out: { task: Task; depth: number }[] = [];
  const walk = (t: Task, depth: number) => {
    out.push({ task: t, depth });
    for (const c of children.get(t.id) ?? []) walk(c, Math.min(depth + 1, 3));
  };
  for (const t of tasks) if (!t.parentId || !ids.has(t.parentId)) walk(t, 0);
  return out;
}

export function viewCounts(tasks: Task[], today: string, inbox: Set<string>) {
  const count = (view: SystemView) =>
    tasks.filter((t) => inSelection(t, { kind: "view", view }, today, inbox)).length;
  return {
    inbox: count("inbox"),
    today: count("today"),
    upcoming: count("upcoming"),
    overdue: count("overdue"),
    all: count("all"),
  };
}

export function parseSelection(params: {
  view?: string;
  list?: string;
  label?: string;
}): Selection {
  if (params.list) return { kind: "list", listId: params.list };
  if (params.label) return { kind: "label", name: params.label };
  const view = (SYSTEM_VIEWS as readonly string[]).includes(params.view ?? "")
    ? (params.view as SystemView)
    : "today";
  return { kind: "view", view };
}

export function selectionQuery(sel: Selection): string {
  const p = new URLSearchParams();
  if (sel.kind === "list") p.set("list", sel.listId);
  else if (sel.kind === "label") p.set("label", sel.name);
  else if (sel.view !== "today") p.set("view", sel.view);
  return p.size ? `?${p}` : "";
}
