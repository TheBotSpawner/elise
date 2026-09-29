"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, CheckSquare, Plus, RotateCcw, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useOptimistic, useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { EmptyState } from "@/components/shared/page";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { TASK_PRIORITIES, type Task } from "@/core/capabilities/tasks";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { taskAction } from "./actions";
import { TaskMeta } from "./task-meta";

const formSchema = z.object({
  title: z.string().trim().min(1).max(500),
  dueDate: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES).or(z.literal("")).optional(),
});
type FormValues = z.infer<typeof formSchema>;

type Optimistic = { id: string; status: Task["status"] | "deleted" };

export function TaskBoard({
  tasks,
  workspaceId,
  timezone,
}: {
  tasks: Task[];
  workspaceId: string;
  timezone: string;
}) {
  const { t } = useI18n();
  const [, startTransition] = useTransition();
  const [view, applyOptimistic] = useOptimistic(tasks, (current, change: Optimistic): Task[] => {
    const { id, status } = change;
    if (status === "deleted") return current.filter((task) => task.id !== id);
    return current.map((task) => (task.id === id ? { ...task, status } : task));
  });
  const [submissionKey, setSubmissionKey] = useState(() => crypto.randomUUID());
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { title: "", dueDate: "", priority: "" },
  });

  // Tasks created or changed from Chat (or another device) show up immediately.
  useRealtimeRefresh(workspaceId, ["tasks"]);

  async function run(operation: Parameters<typeof taskAction>[0], args: unknown, key?: string) {
    const result = await taskAction(operation, args, key);
    if (!result.ok) toast.error(t.errors.codes[result.error.code]);
    return result.ok;
  }

  const onCreate = form.handleSubmit(async (values) => {
    const ok = await run(
      "create",
      {
        title: values.title,
        dueDate: values.dueDate || undefined,
        priority: values.priority || undefined,
      },
      submissionKey,
    );
    if (ok) {
      setSubmissionKey(crypto.randomUUID());
      form.reset();
      toast.success(t.tasks.created);
    }
  });

  function change(task: Task, operation: "complete" | "reopen" | "delete") {
    if (operation === "delete" && !window.confirm(t.tasks.deleteConfirm(task.title))) return;
    startTransition(async () => {
      applyOptimistic({
        id: task.id,
        status:
          operation === "delete" ? "deleted" : operation === "complete" ? "completed" : "pending",
      });
      await run(operation, { taskId: task.id });
    });
  }

  const open = view.filter((task) => task.status === "pending" || task.status === "in_progress");
  const done = view.filter((task) => task.status === "completed");

  return (
    <div className="space-y-8">
      <form
        onSubmit={onCreate}
        className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-3 sm:flex-row"
      >
        <Input
          {...form.register("title")}
          placeholder={t.tasks.newTitle}
          aria-label={t.tasks.newTitle}
          maxLength={500}
          className="flex-1 border-transparent bg-transparent hover:border-transparent"
        />
        <div className="flex gap-2">
          <Input
            type="date"
            {...form.register("dueDate")}
            aria-label={t.tasks.due}
            className="w-auto"
          />
          <Select {...form.register("priority")} aria-label={t.tasks.priority} className="w-auto">
            <option value="">{t.tasks.noPriority}</option>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t.tasks.priorities[p]}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            <Plus />
            <span className="hidden sm:inline">{t.tasks.add}</span>
          </Button>
        </div>
      </form>

      <section aria-labelledby="open-tasks">
        <h2 id="open-tasks" className="mb-3 text-sm font-medium text-muted">
          {t.tasks.open} · {open.length}
        </h2>
        {open.length === 0 ? (
          <EmptyState icon={CheckSquare} title={t.tasks.open} body={t.tasks.empty} />
        ) : (
          <TaskList tasks={open} timezone={timezone} onChange={change} />
        )}
      </section>

      {done.length > 0 && (
        <section aria-labelledby="done-tasks">
          <h2 id="done-tasks" className="mb-3 text-sm font-medium text-muted">
            {t.tasks.completed} · {done.length}
          </h2>
          <TaskList tasks={done} timezone={timezone} onChange={change} />
        </section>
      )}
    </div>
  );
}

function TaskList({
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
                  {task.title}
                  {task.provenance.providerKey !== "elise_native" && (
                    <span className="ml-2 text-[12px] text-faint">{task.provenance.source}</span>
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
