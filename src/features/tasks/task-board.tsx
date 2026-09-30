"use client";

import { Check, CheckSquare, ListPlus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";

import type { TasksOverview } from "@/application/tasks-service";
import { EmptyState } from "@/components/shared/page";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import {
  inTaskView,
  taskCounts,
  TASK_PRIORITIES,
  type Task,
  type TaskPriority,
  type TaskView,
} from "@/core/capabilities/tasks";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { taskAction } from "./actions";
import { TaskMeta } from "./task-meta";

type Optimistic = { id: string; status: Task["status"] | "deleted" };
const VIEWS: TaskView[] = ["open", "today", "overdue", "completed"];

/**
 * Every task account in one place (ELISE and each Google account), each task still living in
 * its own source. Open work first; completed only when asked for.
 */
export function TaskBoard({
  overview,
  view,
  source,
  workspaceId,
  timezone,
}: {
  overview: TasksOverview;
  view: TaskView;
  source: string | null;
  workspaceId: string;
  timezone: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const all = view === "completed" ? (overview.completed ?? []) : overview.open;
  const [tasks, applyOptimistic] = useOptimistic(all, (current, change: Optimistic): Task[] => {
    if (change.status === "deleted") return current.filter((task) => task.id !== change.id);
    return current.map((task) =>
      task.id === change.id ? { ...task, status: change.status as Task["status"] } : task,
    );
  });
  const [listOpen, setListOpen] = useState(false);
  useRealtimeRefresh(workspaceId, ["tasks", "task_lists"]);

  const go = (next: { view?: TaskView; source?: string | null }) => {
    const params = new URLSearchParams();
    const v = next.view ?? view;
    const s = next.source === undefined ? source : next.source;
    if (v !== "open") params.set("view", v);
    if (s) params.set("source", s);
    startTransition(() =>
      router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false }),
    );
  };

  async function run(operation: Parameters<typeof taskAction>[0], args: unknown, key?: string) {
    const result = await taskAction(operation, args, key);
    if (!result.ok) toast.error(result.error.message || t.errors.codes[result.error.code]);
    return result.ok;
  }

  function change(task: Task, operation: "complete" | "reopen" | "delete") {
    if (operation === "delete" && !window.confirm(t.tasks.deleteConfirm(task.title))) return;
    startTransition(async () => {
      applyOptimistic({
        id: task.id,
        status:
          operation === "delete" ? "deleted" : operation === "complete" ? "completed" : "pending",
      });
      if (await run(operation, { taskId: task.id })) router.refresh();
    });
  }

  const visible = tasks.filter(
    (task) =>
      inTaskView(task, view, overview.today) &&
      (!source || task.provenance.connectionId === source),
  );
  // Same definitions as Home's counters (taskCounts), narrowed to the account in view.
  const scoped = taskCounts(
    overview.open.filter((task) => !source || task.provenance.connectionId === source),
    overview.today,
  );
  const counts = {
    open: scoped.open,
    today: scoped.dueToday,
    overdue: scoped.overdue,
    completed: null,
  } as const;

  // Group by account, then by list: a list keeps its identity (Google's or ELISE's).
  const groups = new Map<string, { source: string; list: string | null; tasks: Task[] }>();
  for (const task of visible) {
    const key = `${task.provenance.connectionId}|${task.provenance.listId ?? ""}`;
    const g = groups.get(key) ?? {
      source: task.provenance.source,
      list: task.provenance.listName ?? null,
      tasks: [],
    };
    g.tasks.push(task);
    groups.set(key, g);
  }
  const sourceOrder = overview.sources.map((s) => s.connectionId);
  const ordered = [...groups.entries()]
    .sort(
      ([a], [b]) => sourceOrder.indexOf(a.split("|")[0]!) - sourceOrder.indexOf(b.split("|")[0]!),
    )
    .map(([key, g]) => ({ key, ...g }));

  return (
    <div className="flex flex-col gap-6">
      <NewTask overview={overview} source={source} onCreated={() => router.refresh()} />

      <div className="flex flex-col gap-3">
        <div
          role="tablist"
          aria-label={t.tasks.title}
          className="flex flex-wrap gap-1 self-start rounded-full bg-surface-2 p-1"
        >
          {VIEWS.map((v) => (
            <button
              key={v}
              role="tab"
              type="button"
              aria-selected={v === view}
              onClick={() => go({ view: v })}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-colors",
                v === view ? "bg-bg font-medium text-fg shadow-sm" : "text-muted hover:text-fg",
              )}
            >
              {t.tasks.views[v]}
              {counts[v] !== null && counts[v] > 0 && (
                <span
                  className={cn(
                    "font-mono text-[12px]",
                    v === "overdue" ? "text-danger-text" : "text-faint",
                  )}
                >
                  {counts[v]}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5" aria-label={t.tasks.accounts}>
          {overview.sources.length > 1 &&
            [{ connectionId: null as string | null, label: t.tasks.all }, ...overview.sources].map(
              (s) => (
                <button
                  key={s.connectionId ?? "all"}
                  type="button"
                  aria-pressed={source === s.connectionId}
                  onClick={() => go({ source: s.connectionId })}
                  className={cn(
                    "h-8 rounded-full px-3 text-[13px] transition-colors",
                    source === s.connectionId
                      ? "bg-fg text-bg"
                      : "bg-surface-2 text-muted hover:text-fg",
                  )}
                >
                  {s.label}
                </button>
              ),
            )}
          <Button size="sm" variant="ghost" onClick={() => setListOpen(true)} className="ml-auto">
            <ListPlus />
            {t.tasks.newList}
          </Button>
        </div>
        {overview.unavailable.length > 0 && (
          <p className="text-[12.5px] text-approval-text">
            {t.tasks.unavailable(overview.unavailable.join(", "))}
          </p>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title={t.tasks.views[view]}
          body={t.tasks.emptyViews[view]}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {ordered.map((g) => (
            <section
              key={g.key}
              aria-label={[g.source, g.list].filter(Boolean).join(" · ")}
              className="flex flex-col gap-2"
            >
              {(ordered.length > 1 || overview.sources.length > 1) && (
                <h2 className="flex items-baseline gap-2 text-[13px]">
                  <span className="font-medium">{g.list ?? g.source}</span>
                  <span className="text-faint">{g.list ? g.source : ""}</span>
                  <span className="font-mono text-[12px] text-faint">{g.tasks.length}</span>
                </h2>
              )}
              <TaskRows tasks={g.tasks} timezone={timezone} onChange={change} />
            </section>
          ))}
        </div>
      )}
      <NewListDialog
        open={listOpen}
        onClose={() => setListOpen(false)}
        onCreated={() => router.refresh()}
      />
    </div>
  );
}

function NewTask({
  overview,
  source,
  onCreated,
}: {
  overview: TasksOverview;
  source: string | null;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState<TaskPriority | "">("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  // Default destination: the account filter in view, else ELISE's Inbox (the default account).
  const fallback =
    overview.lists.find((l) => l.provenance.connectionId === source && l.isDefault) ??
    overview.lists.find((l) => l.provenance.providerKey === "elise_native" && l.isDefault) ??
    overview.lists[0];
  const [listId, setListId] = useState<string>("");
  const list = overview.lists.find((l) => l.id === listId) ?? fallback;
  const google = list?.provenance.providerKey === "google";
  const bySource = overview.sources.map((s) => ({
    ...s,
    lists: overview.lists.filter((l) => l.provenance.connectionId === s.connectionId),
  }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        startTransition(async () => {
          const r = await taskAction(
            "create",
            {
              title,
              ...(dueDate ? { dueDate } : {}),
              ...(priority && !google ? { priority } : {}),
              ...(list ? { list: list.id } : {}),
            },
            key,
          );
          if (!r.ok) {
            toast.error(r.error.message || t.errors.codes[r.error.code]);
            return;
          }
          setKey(crypto.randomUUID());
          setTitle("");
          setDueDate("");
          setPriority("");
          toast.success(t.tasks.created);
          onCreated();
        });
      }}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3"
    >
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t.tasks.newTitle}
        aria-label={t.tasks.newTitle}
        maxLength={500}
        className="border-transparent bg-transparent hover:border-transparent"
      />
      <div className="flex flex-wrap gap-2">
        {overview.lists.length > 1 && (
          <Select
            aria-label={t.tasks.destination}
            value={list?.id ?? ""}
            onChange={(e) => setListId(e.target.value)}
            className="w-auto max-w-[16rem]"
          >
            {bySource.map((s) => (
              <optgroup key={s.connectionId} label={s.label}>
                {s.lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {`${s.label} · ${l.name}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        )}
        <Input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          aria-label={t.tasks.due}
          className="w-auto"
        />
        <Select
          value={google ? "" : priority}
          disabled={google}
          title={google ? t.tasks.noPriorityInGoogle : undefined}
          onChange={(e) => setPriority(e.target.value as TaskPriority | "")}
          aria-label={t.tasks.priority}
          className="w-auto"
        >
          <option value="">{t.tasks.noPriority}</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t.tasks.priorities[p]}
            </option>
          ))}
        </Select>
        <Button type="submit" disabled={pending || !title.trim()} className="ml-auto">
          <Plus />
          {t.tasks.add}
        </Button>
      </div>
    </form>
  );
}

function NewListDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      busy={pending}
      title={t.tasks.newList}
      description={t.tasks.newListBody}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          startTransition(async () => {
            const r = await taskAction("createList", { name });
            if (!r.ok) toast.error(r.error.message || t.errors.codes[r.error.code]);
            else {
              setName("");
              onCreated();
              onClose();
            }
          });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="new-list">{t.tasks.listName}</Label>
          <Input
            id="new-list"
            data-autofocus=""
            required
            maxLength={120}
            value={name}
            placeholder={t.tasks.listPlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t.tasks.cancel}
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {t.tasks.createList}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TaskRows({
  tasks,
  timezone,
  onChange,
}: {
  tasks: Task[];
  timezone: string;
  onChange: (task: Task, operation: "complete" | "reopen" | "delete") => void;
}) {
  const { t } = useI18n();
  return (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
      <AnimatePresence initial={false}>
        {tasks.map((task) => {
          const completed = task.status === "completed";
          return (
            <motion.li
              key={task.id}
              layout
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="group flex items-start gap-3 px-4 py-3"
            >
              <button
                type="button"
                onClick={() => onChange(task, completed ? "reopen" : "complete")}
                aria-label={completed ? t.tasks.reopen : t.tasks.complete}
                className={cn(
                  "mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border transition-colors",
                  completed
                    ? "border-accent bg-accent text-accent-fg"
                    : "border-border-strong hover:border-accent",
                )}
              >
                {completed && <Check className="size-3.5" aria-hidden />}
              </button>
              <div className="min-w-0 flex-1">
                <p className={cn("text-sm", completed && "text-muted line-through")}>
                  {task.provenance.url ? (
                    <a
                      href={task.provenance.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {task.title}
                    </a>
                  ) : (
                    task.title
                  )}
                </p>
                {task.description && (
                  <p className="mt-0.5 text-xs text-muted">{task.description}</p>
                )}
                <div className="mt-1">
                  <TaskMeta task={task} timezone={timezone} />
                </div>
              </div>
              <div className="flex gap-1 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                {completed && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() => onChange(task, "reopen")}
                    aria-label={t.tasks.reopen}
                  >
                    <RotateCcw />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 hover:text-danger"
                  onClick={() => onChange(task, "delete")}
                  aria-label={t.tasks.delete}
                >
                  <Trash2 />
                </Button>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
