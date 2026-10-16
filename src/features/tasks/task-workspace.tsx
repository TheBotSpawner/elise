"use client";

import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Flag,
  Hash,
  Inbox,
  ListChecks,
  Plus,
  Search,
  Sun,
  Tag,
  TriangleAlert,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import type { TasksOverview } from "@/application/tasks-service";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { FilterButton, FilterSheet } from "@/components/ui/sheet-menu";
import {
  taskCapabilities,
  TASK_PRIORITIES,
  type Task,
  type TaskList,
  type TaskPriority,
} from "@/core/capabilities/tasks";
import { addDays } from "@/core/time";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useRefreshWhenStale } from "@/hooks/use-refresh-when-stale";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { taskAction } from "./actions";
import { TaskDetail } from "./task-detail";
import {
  applyFilters,
  groupTasks,
  inboxListIds,
  inSelection,
  nest,
  selectionQuery,
  SORTS,
  sortTasks,
  viewCounts,
  type Selection,
  type SortKey,
  type SystemView,
  type TaskFilters,
} from "./views";

/**
 * My Elise → Tasks (ADR-050): a task-management workspace over the one unified task read
 * (tasks-service → tasks.list, the same path as Home, Chat, Canvas and the Morning Brief).
 * Sidebar (views, lists by account, labels) · dense list · detail. Every write goes through the
 * canonical tasks.* tools; the UI updates optimistically and provider truth wins on refresh.
 */

export type TaskOp = Parameters<typeof taskAction>[0];

type Change =
  | { kind: "patch"; id: string; patch: Partial<Task> }
  | { kind: "remove"; id: string }
  | { kind: "add"; task: Task };

const VIEW_ICONS: Record<SystemView, typeof Inbox> = {
  inbox: Inbox,
  today: Sun,
  upcoming: CalendarDays,
  overdue: TriangleAlert,
  completed: Check,
  all: ListChecks,
};

// ── Per-device memory (collapsed account groups, sort) ───────────────────────

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
function readPref(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: it works, it just isn't remembered.
  }
  listeners.forEach((l) => l());
}
function usePref(key: string, fallback: string) {
  return useSyncExternalStore(
    subscribe,
    () => readPref(key, fallback),
    () => fallback,
  );
}

const COLLAPSED = "elise.tasks.collapsed";
const SORT = "elise.tasks.sort";

export function TaskWorkspace({
  overview,
  selection: fromUrl,
  workspaceId,
  timezone,
}: {
  overview: TasksOverview;
  selection: Selection;
  workspaceId: string;
  timezone: string;
}) {
  const { t } = useI18n();
  const w = t.tasks.ws;
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const base = useMemo(
    () => [...overview.open, ...(overview.completed ?? [])],
    [overview.open, overview.completed],
  );
  const [tasks, applyChange] = useOptimistic(base, (current, c: Change): Task[] => {
    if (c.kind === "remove") return current.filter((x) => x.id !== c.id);
    if (c.kind === "add") return [c.task, ...current];
    return current.map((x) => (x.id === c.id ? { ...x, ...c.patch } : x));
  });

  useRealtimeRefresh(workspaceId, ["tasks", "task_lists"]);
  // Google Tasks has no push: read every account again when this snapshot is stale (ADR-046).
  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  useRefreshWhenStale(overview.fetchedAt, refresh);

  // Views switch instantly on the client (open tasks are all loaded); the URL follows. A new
  // server selection (Back, a link) wins.
  const [selection, setSelection] = useState(fromUrl);
  const [urlKey, setUrlKey] = useState(selectionQuery(fromUrl));
  if (selectionQuery(fromUrl) !== urlKey) {
    setUrlKey(selectionQuery(fromUrl));
    setSelection(fromUrl);
  }
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TaskFilters>({});
  const sort = usePref(SORT, "manual") as SortKey;
  const collapsed = new Set(JSON.parse(usePref(COLLAPSED, "[]")) as string[]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const quickRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const today = overview.today;
  const inbox = useMemo(() => inboxListIds(overview.lists), [overview.lists]);
  const counts = useMemo(() => viewCounts(tasks, today, inbox), [tasks, today, inbox]);
  const listCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of tasks)
      if (x.status !== "completed" && x.provenance.listId)
        m.set(x.provenance.listId, (m.get(x.provenance.listId) ?? 0) + 1);
    return m;
  }, [tasks]);

  // Searching spans every task (all views); otherwise the selected view.
  const searching = search.trim().length > 0;
  const scoped = searching ? tasks : tasks.filter((x) => inSelection(x, selection, today, inbox));
  const visible = sortTasks(applyFilters(scoped, filters, today, search), sort);
  const groups = searching
    ? [{ key: "all", tasks: visible }]
    : groupTasks(visible, selection, today);
  const rows = groups.flatMap((g) => nest(g.tasks).map((r) => ({ ...r, group: g.key })));
  const order = rows.map((r) => r.task.id);
  const selected = tasks.find((x) => x.id === selectedId) ?? null;

  const go = (sel: Selection) => {
    setNavOpen(false);
    setSearch("");
    setSelection(sel);
    const href = `${pathname}${selectionQuery(sel)}`;
    // Completed history loads only when asked for (ADR-009): that view needs the server.
    if (sel.kind === "view" && sel.view === "completed" && !overview.completed)
      startTransition(() => router.replace(href, { scroll: false }));
    else window.history.replaceState(null, "", href);
  };

  /** One write: optimistic first, provider truth after (a failure restores the row). */
  const mutate = useCallback(
    (op: TaskOp, args: Record<string, unknown>, change?: Change, key?: string) =>
      new Promise<Task | null>((resolve) => {
        startTransition(async () => {
          if (change) applyChange(change);
          const r = await taskAction(op, args, key);
          if (!r.ok) {
            toast.error(`${w.failed} ${errorText(t, r.error)}`);
            resolve(null);
            return;
          }
          router.refresh();
          resolve(r.task);
        });
      }),
    [applyChange, router, t, w.failed],
  );

  const toggle = useCallback(
    (task: Task) => {
      const done = task.status === "completed";
      void mutate(
        done ? "reopen" : "complete",
        { taskId: task.id },
        {
          kind: "patch",
          id: task.id,
          patch: done
            ? { status: "pending", completedAt: null }
            : { status: "completed", completedAt: new Date().toISOString() },
        },
      );
    },
    [mutate],
  );

  // Keyboard: N new · / search · ↑↓ (or J/K) move · Enter open · X complete · Esc close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "");
      if (e.key === "Escape") {
        if (typing) (el as HTMLElement).blur();
        else if (detailOpen) setDetailOpen(false);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = selectedId ? order.indexOf(selectedId) : -1;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        quickRef.current?.focus();
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setSelectedId(order[Math.min(order.length - 1, at + 1)] ?? null);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setSelectedId(order[Math.max(0, at - 1)] ?? null);
      } else if (e.key === "Enter" && selectedId) {
        setDetailOpen(true);
      } else if ((e.key === "x" || e.key === "X") && selected) {
        toggle(selected);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [order, selectedId, selected, detailOpen, toggle]);

  // The selected row stays in view while moving with the keyboard.
  useEffect(() => {
    if (selectedId)
      document
        .querySelector(`[data-task-row="${CSS.escape(selectedId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const bySource = overview.sources.map((s) => ({
    ...s,
    lists: overview.lists.filter((l) => l.provenance.connectionId === s.connectionId),
  }));
  const title =
    selection.kind === "view"
      ? w.views[selection.view]
      : selection.kind === "list"
        ? (overview.lists.find((l) => l.id === selection.listId)?.name ?? w.lists)
        : `#${selection.name}`;
  const currentList =
    selection.kind === "list" ? overview.lists.find((l) => l.id === selection.listId) : undefined;
  const emptyText = searching
    ? w.empty.search
    : selection.kind === "view"
      ? w.empty[selection.view]
      : w.empty[selection.kind];

  const sidebar = (
    <nav aria-label={w.menu} className="flex flex-col gap-4 text-[13.5px]">
      <div className="flex flex-col gap-2">
        <label className="relative block">
          <span className="sr-only">{w.search}</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint"
            aria-hidden
          />
          <Input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={w.search}
            className="h-9 pl-8 text-[13.5px]"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setNavOpen(false);
            quickRef.current?.focus();
          }}
          className="flex h-9 items-center gap-2 rounded-xl border border-accent-line px-3 text-accent-text transition-colors hover:bg-accent-soft"
        >
          <Plus className="size-4" aria-hidden />
          {w.newTask}
        </button>
      </div>
      <ul className="flex flex-col">
        {(["inbox", "today", "upcoming", "overdue", "completed", "all"] as const).map((v) => {
          const Icon = VIEW_ICONS[v];
          const active = selection.kind === "view" && selection.view === v && !searching;
          const n = v === "completed" ? null : counts[v];
          return (
            <li key={v}>
              <NavItem
                active={active}
                onClick={() => go({ kind: "view", view: v })}
                icon={<Icon className="size-4" aria-hidden />}
                count={n}
                alert={v === "overdue" && (n ?? 0) > 0}
              >
                {w.views[v]}
              </NavItem>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-1">
        <p className="px-2 font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
          {w.lists}
        </p>
        {bySource.map((s) => {
          const closed = collapsed.has(s.connectionId);
          return (
            <div key={s.connectionId}>
              <button
                type="button"
                aria-expanded={!closed}
                onClick={() =>
                  writePref(
                    COLLAPSED,
                    JSON.stringify(
                      closed
                        ? [...collapsed].filter((x) => x !== s.connectionId)
                        : [...collapsed, s.connectionId],
                    ),
                  )
                }
                className="flex w-full items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-muted hover:text-fg"
              >
                {closed ? (
                  <ChevronRight className="size-3.5" aria-hidden />
                ) : (
                  <ChevronDown className="size-3.5" aria-hidden />
                )}
                <span className="truncate">
                  {s.providerKey === "google" ? `Google · ${s.label}` : s.label}
                </span>
              </button>
              {!closed && (
                <ul className="flex flex-col">
                  {s.lists.map((l) => (
                    <li key={l.id}>
                      <NavItem
                        active={
                          selection.kind === "list" && selection.listId === l.id && !searching
                        }
                        onClick={() => go({ kind: "list", listId: l.id })}
                        icon={<Hash className="size-3.5" aria-hidden />}
                        count={listCounts.get(l.id) ?? 0}
                        inset
                      >
                        {l.name}
                      </NavItem>
                    </li>
                  ))}
                  {s.providerKey === "elise_native" && (
                    <li>
                      <NewList onCreate={(name) => void mutate("createList", { name })} />
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
        {overview.unavailable.length > 0 && (
          <p className="px-2 text-[12px] text-approval-text">
            {t.tasks.unavailable(overview.unavailable.join(", "))}
          </p>
        )}
      </div>
      {overview.labels.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="px-2 font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
            {w.labels}
          </p>
          <ul className="flex flex-col">
            {overview.labels.map((l) => (
              <li key={l.name}>
                <NavItem
                  active={selection.kind === "label" && selection.name === l.name && !searching}
                  onClick={() => go({ kind: "label", name: l.name })}
                  icon={<Tag className="size-3.5" aria-hidden />}
                  count={l.count}
                >
                  {l.name}
                </NavItem>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="hidden px-2 text-[11px] leading-relaxed text-faint lg:block">{w.shortcuts}</p>
    </nav>
  );

  return (
    <div
      className={cn(
        "grid gap-6 md:grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[240px_minmax(0,1fr)]",
        detailOpen && selected && "xl:grid-cols-[240px_minmax(0,1fr)_400px]",
      )}
    >
      {/* Sidebar: inline from md up; a drawer on mobile. */}
      <aside className="hidden md:block">
        <div className="sticky top-6">{sidebar}</div>
      </aside>
      {/* Phones (ADR-066): the views open in a sheet, within thumb reach. */}
      <Dialog open={navOpen} onClose={() => setNavOpen(false)} title={w.menu}>
        <div className="-mx-2 [&_button]:min-h-11">{sidebar}</div>
      </Dialog>
      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        onClear={() => setFilters({})}
      >
        <FilterBar overview={overview} filters={filters} onChange={setFilters} stacked />
        <Select aria-label={w.sort} value={sort} onChange={(e) => writePref(SORT, e.target.value)}>
          {SORTS.map((s) => (
            <option key={s} value={s}>
              {w.sorts[s]}
            </option>
          ))}
        </Select>
      </FilterSheet>

      <section aria-label={title} className="flex min-w-0 flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2">
          {/* Phones: the current view is the switcher ("Hoy · 2"); filters sit beside it. */}
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-haspopup="dialog"
            aria-label={`${w.menu}: ${searching ? search.trim() : title}`}
            className="flex h-11 min-w-0 items-center gap-2 rounded-full border border-border pr-3 pl-4 md:hidden"
          >
            <span className="truncate text-[16px] font-medium tracking-tight">
              {searching ? `“${search.trim()}”` : title}
            </span>
            <span className="font-mono text-[12px] text-faint">{visible.length}</span>
            <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
          </button>
          <FilterButton
            className="ml-auto md:hidden"
            count={
              [filters.source, filters.priority, filters.label, filters.thisWeek].filter(Boolean)
                .length
            }
            onClick={() => setFiltersOpen(true)}
          />
          <h2 className="hidden text-[18px] font-medium tracking-tight md:block">
            {searching ? `“${search.trim()}”` : title}
          </h2>
          <span className="hidden font-mono text-[12px] text-faint md:inline">
            {visible.length}
          </span>
          {pending && <span className="text-[12px] text-faint">{w.refreshing}</span>}
          <div className="ml-auto hidden flex-wrap items-center gap-1.5 md:flex">
            <FilterBar overview={overview} filters={filters} onChange={setFilters} />
            <Select
              aria-label={w.sort}
              value={sort}
              onChange={(e) => writePref(SORT, e.target.value)}
              className="h-8 w-auto py-0 text-[12.5px]"
            >
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {w.sorts[s]}
                </option>
              ))}
            </Select>
          </div>
        </header>
        <Freshness at={overview.fetchedAt} />

        <QuickAdd
          inputRef={quickRef}
          overview={overview}
          defaultList={currentList}
          defaultDate={
            selection.kind === "view" && selection.view === "today"
              ? today
              : selection.kind === "view" && selection.view === "upcoming"
                ? addDays(today, 1)
                : ""
          }
          defaultLabel={selection.kind === "label" ? selection.name : undefined}
          onCreate={(args, optimistic, key) => mutate("create", args, optimistic, key)}
        />

        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[13.5px] text-muted">
            {emptyText}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map((g) => (
              <div key={g.key} className="flex flex-col">
                {w.groups[g.key as keyof typeof w.groups] && (
                  <h3
                    className={cn(
                      "px-1 pb-1 font-mono text-[10px] tracking-[0.14em] uppercase",
                      g.key === "overdue" ? "text-danger-text" : "text-faint",
                    )}
                  >
                    {w.groups[g.key as keyof typeof w.groups]} · {g.tasks.length}
                  </h3>
                )}
                <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                  {nest(g.tasks).map(({ task, depth }) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      depth={depth}
                      today={today}
                      timezone={timezone}
                      showList={selection.kind !== "list" || searching}
                      subtasks={tasks.filter((x) => x.parentId === task.id).length}
                      selected={task.id === selectedId}
                      onSelect={() => {
                        setSelectedId(task.id);
                        setDetailOpen(true);
                      }}
                      onToggle={() => toggle(task)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {detailOpen && selected && (
        <TaskDetail
          key={selected.id}
          task={selected}
          all={tasks}
          overview={overview}
          today={today}
          timezone={timezone}
          position={{ at: order.indexOf(selected.id), total: order.length }}
          onClose={() => setDetailOpen(false)}
          onStep={(d) => {
            const next = order[order.indexOf(selected.id) + d];
            if (next) setSelectedId(next);
          }}
          onToggle={toggle}
          mutate={mutate}
          onDeleted={() => {
            setDetailOpen(false);
            setSelectedId(null);
          }}
          onOpenTask={(id) => setSelectedId(id)}
        />
      )}
    </div>
  );
}

function NavItem({
  active,
  onClick,
  icon,
  count,
  alert,
  inset,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  count?: number | null;
  alert?: boolean;
  inset?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
        inset && "pl-5",
        active ? "bg-accent-soft text-accent-text" : "text-fg2 hover:bg-active hover:text-fg",
      )}
    >
      <span className={cn("shrink-0", active ? "text-accent-text" : "text-faint")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count ? (
        <span className={cn("font-mono text-[11px]", alert ? "text-danger-text" : "text-faint")}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** A new ELISE list, inline (Google lists are created in Google). */
function NewList({ onCreate }: { onCreate: (name: string) => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  if (!editing)
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 pl-5 text-left text-[12.5px] text-faint hover:text-fg"
      >
        <Plus className="size-3.5" aria-hidden />
        {t.tasks.newList}
      </button>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onCreate(name.trim());
        setName("");
        setEditing(false);
      }}
      className="py-1 pr-2 pl-5"
    >
      <input
        autoFocus
        value={name}
        maxLength={120}
        aria-label={t.tasks.listName}
        placeholder={t.tasks.listPlaceholder}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => !name.trim() && setEditing(false)}
        className="h-8 w-full rounded-lg border border-border bg-transparent px-2 text-[12.5px] outline-none focus:border-accent-line"
      />
    </form>
  );
}

/** "Actualizado ahora" / "hace 3 min" — the only sync UI (ADR-046). */
function Freshness({ at }: { at: string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.parse(at));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  return (
    <p className="-mt-2 text-[11.5px] text-faint">
      {minutes < 1 ? t.tasks.updatedNow : t.tasks.updatedAgo(minutes)}
    </p>
  );
}

function FilterBar({
  overview,
  filters,
  onChange,
  stacked = false,
}: {
  overview: TasksOverview;
  filters: TaskFilters;
  onChange: (f: TaskFilters) => void;
  /** In the phone filter sheet: full-width rows. */
  stacked?: boolean;
}) {
  const { t } = useI18n();
  const w = t.tasks.ws;
  const active = Boolean(filters.source || filters.priority || filters.label || filters.thisWeek);
  const cls = stacked ? "" : "h-8 w-auto max-w-[11rem] py-0 text-[12.5px]";
  return (
    <div
      role="group"
      aria-label={w.filters}
      className={cn("flex gap-1.5", stacked ? "flex-col gap-4" : "flex-wrap items-center")}
    >
      {overview.sources.length > 1 && (
        <Select
          aria-label={w.account}
          value={filters.source ?? ""}
          onChange={(e) => onChange({ ...filters, source: e.target.value || null })}
          className={cls}
        >
          <option value="">{w.anyAccount}</option>
          {overview.sources.map((s) => (
            <option key={s.connectionId} value={s.connectionId}>
              {s.label}
            </option>
          ))}
        </Select>
      )}
      <Select
        aria-label={t.tasks.priority}
        value={filters.priority ?? ""}
        onChange={(e) =>
          onChange({ ...filters, priority: (e.target.value || null) as TaskPriority | null })
        }
        className={cls}
      >
        <option value="">{w.anyPriority}</option>
        {[...TASK_PRIORITIES].reverse().map((p) => (
          <option key={p} value={p}>
            {w.p[p]}
          </option>
        ))}
      </Select>
      {overview.labels.length > 0 && (
        <Select
          aria-label={w.labels}
          value={filters.label ?? ""}
          onChange={(e) => onChange({ ...filters, label: e.target.value || null })}
          className={cls}
        >
          <option value="">{w.anyLabel}</option>
          {overview.labels.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </Select>
      )}
      <button
        type="button"
        aria-pressed={Boolean(filters.thisWeek)}
        onClick={() => onChange({ ...filters, thisWeek: !filters.thisWeek })}
        className={cn(
          "rounded-lg border px-2.5 transition-colors",
          stacked ? "h-12 rounded-full text-[15px]" : "h-8 text-[12.5px]",
          filters.thisWeek
            ? "border-accent-line bg-accent-soft text-accent-text"
            : "border-border text-muted hover:text-fg",
        )}
      >
        {w.thisWeek}
      </button>
      {active && !stacked && (
        <button
          type="button"
          onClick={() => onChange({})}
          className="h-8 px-1.5 text-[12.5px] text-muted hover:text-fg"
        >
          {w.clearFilters}
        </button>
      )}
    </div>
  );
}

function QuickAdd({
  inputRef,
  overview,
  defaultList,
  defaultDate,
  defaultLabel,
  onCreate,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  overview: TasksOverview;
  defaultList?: TaskList;
  defaultDate: string;
  defaultLabel?: string;
  onCreate: (
    args: Record<string, unknown>,
    optimistic: Change,
    key: string,
  ) => Promise<Task | null>;
}) {
  const { t } = useI18n();
  const w = t.tasks.ws;
  const [title, setTitle] = useState("");
  const [date, setDate] = useState<string | null>(null);
  const [listId, setListId] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  // Phones (ADR-066): one row until it's used; destination, date and "Más" appear then.
  const [engaged, setEngaged] = useState(false);
  const [priority, setPriority] = useState<TaskPriority | "">("");
  const [description, setDescription] = useState("");
  // Smart default: the list in view, else ELISE's Inbox.
  const fallback =
    defaultList ??
    overview.lists.find((l) => l.provenance.providerKey === "elise_native" && l.isDefault) ??
    overview.lists[0];
  const list = overview.lists.find((l) => l.id === listId) ?? fallback;
  const due = date ?? defaultDate;

  const submit = () => {
    const name = title.trim();
    if (!name || !list) return;
    const key = crypto.randomUUID();
    const args: Record<string, unknown> = {
      title: name,
      list: list.id,
      ...(due ? { dueDate: due } : {}),
      ...(priority ? { priority } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(defaultLabel ? { labels: [defaultLabel] } : {}),
    };
    const now = new Date().toISOString();
    void onCreate(
      args,
      {
        kind: "add",
        task: {
          id: `pending-${key}`,
          title: name,
          description: description.trim() || null,
          notes: null,
          status: "pending",
          priority: priority || null,
          category: null,
          parentId: null,
          labels: defaultLabel ? [defaultLabel] : [],
          dueDate: due || null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          provenance: {
            providerKey: list.provenance.providerKey,
            connectionId: list.provenance.connectionId,
            externalId: "",
            source: list.provenance.source,
            listId: list.id,
            listName: list.name,
          },
        },
      },
      key,
    );
    setTitle("");
    setDescription("");
    setPriority("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onFocus={() => setEngaged(true)}
      className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-3 py-1.5 focus-within:border-accent-line md:py-2"
    >
      <div className="flex items-center gap-2">
        <Plus className="size-4 shrink-0 text-accent-text" aria-hidden />
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={w.quickAdd}
          aria-label={t.tasks.newTitle}
          maxLength={500}
          className="h-10 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-faint md:h-8"
        />
      </div>
      <div
        className={cn("flex flex-wrap items-center gap-1.5", !engaged && !title && "max-md:hidden")}
      >
        {overview.lists.length > 1 && (
          <Select
            aria-label={t.tasks.destination}
            value={list?.id ?? ""}
            onChange={(e) => setListId(e.target.value)}
            className="h-8 w-auto max-w-[15rem] py-0 text-[12.5px]"
          >
            {overview.sources.map((s) => (
              <optgroup key={s.connectionId} label={s.label}>
                {overview.lists
                  .filter((l) => l.provenance.connectionId === s.connectionId)
                  .map((l) => (
                    <option key={l.id} value={l.id}>{`${s.label} · ${l.name}`}</option>
                  ))}
              </optgroup>
            ))}
          </Select>
        )}
        <Input
          type="date"
          value={due}
          onChange={(e) => setDate(e.target.value)}
          aria-label={t.tasks.due}
          className="h-8 w-auto py-0 text-[12.5px]"
        />
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
          className="h-8 px-2 text-[12.5px] text-muted hover:text-fg"
        >
          {w.more}
        </button>
        <button
          type="submit"
          disabled={!title.trim()}
          className="ml-auto h-8 rounded-lg bg-fg px-3 text-[12.5px] text-bg disabled:opacity-40"
        >
          {t.tasks.add}
        </button>
      </div>
      {more && (
        <div className="flex flex-col gap-2 pb-1">
          <Select
            aria-label={t.tasks.priority}
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority | "")}
            className="h-8 w-auto py-0 text-[12.5px]"
          >
            <option value="">{t.tasks.noPriority}</option>
            {[...TASK_PRIORITIES].reverse().map((p) => (
              <option key={p} value={p}>
                {w.p[p]}
              </option>
            ))}
          </Select>
          {list &&
            taskCapabilities(list.provenance.providerKey).priority === "elise" &&
            priority && <p className="text-[11.5px] text-faint">{w.eliseOnly}</p>}
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={w.descriptionPlaceholder}
            aria-label={w.description}
            rows={2}
            maxLength={5000}
            className="w-full resize-y rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-accent-line"
          />
        </div>
      )}
    </form>
  );
}

export function PriorityFlag({ priority }: { priority: Task["priority"] }) {
  const { t } = useI18n();
  if (!priority) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 font-mono text-[11px]",
        priority === "high" ? "text-accent-text" : "text-muted",
      )}
      aria-label={`${t.tasks.priority}: ${t.tasks.ws.p[priority]}`}
    >
      <Flag className="size-3" aria-hidden />
      {t.tasks.ws.p[priority]}
    </span>
  );
}

export function DueChip({ date, today, open }: { date: string; today: string; open: boolean }) {
  const { t, locale } = useI18n();
  const label =
    date === today
      ? t.tasks.today
      : date === addDays(today, 1)
        ? t.tasks.tomorrow
        : new Intl.DateTimeFormat(locale, {
            day: "numeric",
            month: "short",
            timeZone: "UTC",
          }).format(new Date(`${date}T00:00:00Z`));
  const overdue = open && date < today;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11.5px]",
        overdue ? "text-danger-text" : date === today ? "text-accent-text" : "text-muted",
      )}
    >
      <CalendarDays className="size-3" aria-hidden />
      {label}
    </span>
  );
}

function TaskRow({
  task,
  depth,
  today,
  showList,
  subtasks,
  selected,
  onSelect,
  onToggle,
}: {
  task: Task;
  depth: number;
  today: string;
  timezone: string;
  showList: boolean;
  subtasks: number;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const done = task.status === "completed";
  const pendingCreate = task.id.startsWith("pending-");
  return (
    <li
      data-task-row={task.id}
      className={cn(
        "group flex items-start gap-3 px-3 py-2.5 transition-colors md:gap-2.5 md:py-[7px]",
        selected ? "bg-accent-soft/60" : "hover:bg-active",
        pendingCreate && "opacity-60",
      )}
      style={depth ? { paddingLeft: `${12 + depth * 22}px` } : undefined}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={done}
        aria-label={`${done ? t.tasks.reopen : t.tasks.complete}: ${task.title}`}
        disabled={pendingCreate}
        onClick={onToggle}
        className={cn(
          "touch-hit mt-[2px] grid size-5 shrink-0 place-items-center rounded-full border transition-colors md:mt-[3px] md:size-[17px]",
          done
            ? "border-accent bg-accent text-accent-fg"
            : task.priority === "high"
              ? "border-accent-line hover:border-accent"
              : "border-border-strong hover:border-accent",
        )}
      >
        {done && <Check className="size-3" strokeWidth={3} aria-hidden />}
      </button>
      <button
        type="button"
        onClick={onSelect}
        disabled={pendingCreate}
        aria-current={selected ? "true" : undefined}
        className="min-w-0 flex-1 text-left"
      >
        <span
          className={cn(
            "block truncate text-[15px] leading-6 md:text-[13.5px] md:leading-5",
            done && "text-faint line-through",
          )}
        >
          {task.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
          {task.dueDate && <DueChip date={task.dueDate} today={today} open={!done} />}
          <PriorityFlag priority={task.priority} />
          {subtasks > 0 && (
            <span className="text-[11.5px] text-muted">{t.tasks.ws.subtaskCount(subtasks)}</span>
          )}
          {(task.labels ?? []).map((l) => (
            <span key={l} className="text-[11.5px] text-accent-text/80">
              #{l}
            </span>
          ))}
          {showList && (
            <span className="truncate text-[11.5px] text-faint">
              {task.provenance.listName
                ? `${task.provenance.listName} · ${task.provenance.source}`
                : task.provenance.source}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
