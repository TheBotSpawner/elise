"use client";

import { Check, ChevronDown, ChevronUp, ExternalLink, Plus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { TasksOverview } from "@/application/tasks-service";
import { Input, Select } from "@/components/ui/input";
import {
  taskCapabilities,
  TASK_PRIORITIES,
  type Task,
  type TaskPriority,
} from "@/core/capabilities/tasks";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { RepeatField, type RepeatScope } from "./repeat-field";
import type { TaskOp } from "./task-workspace";

type Change =
  | { kind: "patch"; id: string; patch: Partial<Task> }
  | { kind: "remove"; id: string }
  | { kind: "add"; task: Task };

/**
 * One task, in place (ADR-050): a right panel on wide screens, a sheet over the list below that,
 * full screen on mobile. Every field writes through tasks.* to the task's own provider; fields a
 * provider can't hold (Google: priority, labels) are ELISE's enrichment and say so subtly.
 */
export function TaskDetail({
  task,
  all,
  overview,
  today,
  position,
  onClose,
  onStep,
  onToggle,
  mutate,
  onDeleted,
  onOpenTask,
}: {
  task: Task;
  all: Task[];
  overview: TasksOverview;
  today: string;
  timezone: string;
  position: { at: number; total: number };
  onClose: () => void;
  onStep: (delta: number) => void;
  onToggle: (task: Task, element?: Element) => void;
  mutate: (
    op: TaskOp,
    args: Record<string, unknown>,
    change?: Change,
    key?: string,
  ) => Promise<Task | null>;
  onDeleted: () => void;
  onOpenTask: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const w = t.tasks.ws;
  const caps = taskCapabilities(task.provenance.providerKey);
  const google = task.provenance.providerKey === "google";
  const done = task.status === "completed";
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [labelDraft, setLabelDraft] = useState("");
  const [subDraft, setSubDraft] = useState("");
  // ADR-115: what an edit of a recurring task changes; this occurrence unless the user says.
  const [scope, setScope] = useState<RepeatScope>("this");
  const titleRef = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);

  // Focus moves into the panel and back to the list when it closes.
  useEffect(() => {
    restore.current = document.activeElement as HTMLElement | null;
    titleRef.current?.focus({ preventScroll: true });
    return () => restore.current?.focus?.({ preventScroll: true });
  }, []);

  const update = (args: Record<string, unknown>, patch: Partial<Task>) =>
    void mutate(
      "update",
      { taskId: task.id, ...args, ...(task.recurrence ? { repeatScope: scope } : {}) },
      { kind: "patch", id: task.id, patch },
    );

  const lists = overview.lists.filter(
    (l) => l.provenance.connectionId === task.provenance.connectionId,
  );
  const children = all.filter((x) => x.parentId === task.id);
  const origin = [
    google ? "Google Tasks" : "ELISE",
    google ? task.provenance.source : null,
    task.provenance.listName,
  ]
    .filter(Boolean)
    .join(" · ");
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));

  return (
    <div className="fixed inset-0 z-50 flex justify-end xl:static xl:z-auto xl:block">
      <button
        type="button"
        aria-label={w.close}
        onClick={onClose}
        className="absolute inset-0 bg-black/40 xl:hidden"
      />
      <aside
        aria-label={task.title}
        className="relative flex h-full w-full flex-col overflow-y-auto border-border bg-bg sm:max-w-[440px] sm:border-l xl:sticky xl:top-6 xl:h-auto xl:max-h-[calc(100vh-7rem)] xl:max-w-none xl:rounded-xl xl:border xl:bg-surface"
      >
        <header className="flex items-center gap-1 border-b border-border px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
            {origin}
          </span>
          <IconButton label={w.previous} disabled={position.at <= 0} onClick={() => onStep(-1)}>
            <ChevronUp className="size-4" />
          </IconButton>
          <IconButton
            label={w.next}
            disabled={position.at >= position.total - 1}
            onClick={() => onStep(1)}
          >
            <ChevronDown className="size-4" />
          </IconButton>
          <IconButton label={w.close} onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>

        <div className="flex flex-col gap-4 px-4 py-4">
          <div className="flex items-start gap-2.5">
            <button
              type="button"
              role="checkbox"
              aria-checked={done}
              aria-label={done ? t.tasks.reopen : t.tasks.complete}
              onClick={(e) => onToggle(task, e.currentTarget)}
              className={cn(
                "mt-2 grid size-5 shrink-0 place-items-center rounded-full border transition-colors",
                done
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border-strong hover:border-accent",
              )}
            >
              {done && <Check className="size-3.5" strokeWidth={3} aria-hidden />}
            </button>
            <input
              ref={titleRef}
              value={title}
              aria-label={w.title}
              maxLength={500}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              onBlur={() => {
                const next = title.trim();
                if (next && next !== task.title) update({ title: next }, { title: next });
                else setTitle(task.title);
              }}
              className={cn(
                "min-w-0 flex-1 rounded-lg bg-transparent px-1 py-1 text-[17px] font-medium outline-none focus:bg-active",
                done && "text-muted line-through",
              )}
            />
          </div>

          <textarea
            value={description}
            aria-label={w.description}
            placeholder={w.descriptionPlaceholder}
            maxLength={5000}
            rows={Math.min(10, Math.max(3, description.split("\n").length + 1))}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => {
              const next = description.trim();
              if (next !== (task.description ?? ""))
                update({ description: next || null }, { description: next || null });
            }}
            className="w-full resize-y rounded-lg border border-border bg-transparent px-3 py-2 text-[13.5px] leading-relaxed outline-none placeholder:text-faint focus:border-accent-line"
          />

          <dl className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-[13px]">
            <dt className="text-muted">{w.date}</dt>
            <dd className="flex flex-col gap-0.5">
              <Input
                type="date"
                value={task.dueDate ?? ""}
                aria-label={w.date}
                onChange={(e) =>
                  update({ dueDate: e.target.value || null }, { dueDate: e.target.value || null })
                }
                className="h-8 w-auto py-0 text-[13px]"
              />
              {!caps.dueTime && <span className="text-[11px] text-faint">{w.noDueTime}</span>}
            </dd>

            {!task.parentId && !done && (
              <>
                <dt className="self-start pt-1.5 text-muted">{w.repeat.label}</dt>
                <dd>
                  <RepeatField
                    rrule={task.recurrence?.rrule ?? null}
                    dueDate={task.dueDate}
                    today={today}
                    scope={scope}
                    onScope={setScope}
                    onChange={(repeat) =>
                      void mutate(
                        "update",
                        {
                          taskId: task.id,
                          repeat,
                          ...(task.recurrence && scope !== "this" ? { repeatScope: scope } : {}),
                        },
                        {
                          kind: "patch",
                          id: task.id,
                          patch: { recurrence: repeat ? task.recurrence : null },
                        },
                      )
                    }
                  />
                </dd>
              </>
            )}

            <dt className="text-muted">{t.tasks.priority}</dt>
            <dd className="flex flex-col gap-0.5">
              <Select
                aria-label={t.tasks.priority}
                value={task.priority ?? ""}
                onChange={(e) => {
                  const p = (e.target.value || null) as TaskPriority | null;
                  update({ priority: p }, { priority: p });
                }}
                className="h-8 w-auto py-0 text-[13px]"
              >
                <option value="">{w.noPriorityShort}</option>
                {[...TASK_PRIORITIES].reverse().map((p) => (
                  <option key={p} value={p}>
                    {`${w.p[p]} · ${t.tasks.priorities[p]}`}
                  </option>
                ))}
              </Select>
            </dd>

            <dt className="text-muted">{w.list}</dt>
            <dd>
              <Select
                aria-label={w.list}
                value={task.provenance.listId ?? ""}
                disabled={!caps.moveBetweenLists || lists.length < 2 || Boolean(task.parentId)}
                onChange={(e) => {
                  const l = lists.find((x) => x.id === e.target.value);
                  if (l)
                    update(
                      { list: l.id },
                      { provenance: { ...task.provenance, listId: l.id, listName: l.name } },
                    );
                }}
                className="h-8 w-auto max-w-full py-0 text-[13px]"
              >
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </dd>

            <dt className="self-start pt-1 text-muted">{w.labels}</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              {(task.labels ?? []).map((l) => (
                <span
                  key={l}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[12px] text-accent-text"
                >
                  #{l}
                  <button
                    type="button"
                    aria-label={w.removeLabel(l)}
                    onClick={() =>
                      update(
                        { removeLabels: [l] },
                        { labels: (task.labels ?? []).filter((x) => x !== l) },
                      )
                    }
                    className="text-faint hover:text-fg"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
              <input
                value={labelDraft}
                list="task-label-options"
                aria-label={w.addLabel}
                placeholder={`+ ${w.addLabel}`}
                maxLength={60}
                onChange={(e) => setLabelDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const name = labelDraft.trim();
                  if (!name) return;
                  setLabelDraft("");
                  if ((task.labels ?? []).some((x) => x.toLowerCase() === name.toLowerCase()))
                    return;
                  update({ addLabels: [name] }, { labels: [...(task.labels ?? []), name] });
                }}
                className="h-7 w-32 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
              />
              <datalist id="task-label-options">
                {overview.labels.map((l) => (
                  <option key={l.name} value={l.name} />
                ))}
              </datalist>
            </dd>
          </dl>
          {(caps.priority === "elise" || caps.labels === "elise") &&
            (task.priority || (task.labels ?? []).length > 0) && (
              <p className="-mt-2 text-[11px] text-faint">{w.eliseOnly}</p>
            )}

          {caps.subtasks && (
            <section aria-label={w.subtasks} className="flex flex-col gap-1">
              <h3 className="font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
                {w.subtasks}
                {children.length > 0 && ` · ${children.length}`}
              </h3>
              <ul className="flex flex-col">
                {children.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 py-1">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={c.status === "completed"}
                      aria-label={`${t.tasks.complete}: ${c.title}`}
                      onClick={(e) => onToggle(c, e.currentTarget)}
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-full border",
                        c.status === "completed"
                          ? "border-accent bg-accent text-accent-fg"
                          : "border-border-strong hover:border-accent",
                      )}
                    >
                      {c.status === "completed" && <Check className="size-2.5" strokeWidth={3} />}
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenTask(c.id)}
                      className={cn(
                        "min-w-0 flex-1 truncate text-left text-[13px] hover:underline",
                        c.status === "completed" && "text-faint line-through",
                      )}
                    >
                      {c.title}
                    </button>
                  </li>
                ))}
              </ul>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = subDraft.trim();
                  if (!name) return;
                  setSubDraft("");
                  const key = crypto.randomUUID();
                  const now = new Date().toISOString();
                  void mutate(
                    "create",
                    { title: name, parentTaskId: task.id },
                    {
                      kind: "add",
                      task: {
                        ...task,
                        id: `pending-${key}`,
                        title: name,
                        description: null,
                        status: "pending",
                        priority: null,
                        labels: [],
                        dueDate: null,
                        completedAt: null,
                        createdAt: now,
                        updatedAt: now,
                        parentId: task.id,
                        position: undefined,
                      },
                    },
                    key,
                  );
                }}
                className="flex items-center gap-2 py-1"
              >
                <Plus className="size-3.5 text-faint" aria-hidden />
                <input
                  value={subDraft}
                  onChange={(e) => setSubDraft(e.target.value)}
                  placeholder={w.addSubtask}
                  aria-label={w.addSubtask}
                  maxLength={500}
                  className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
                />
              </form>
            </section>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-[11.5px] text-faint">
            {!google && (
              <span>
                {w.created} {date(task.createdAt)}
              </span>
            )}
            <span>
              {w.updated} {date(task.updatedAt)}
            </span>
            {task.provenance.url && (
              <a
                href={task.provenance.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-fg"
              >
                <ExternalLink className="size-3" aria-hidden />
                {w.openInProvider}
              </a>
            )}
            <button
              type="button"
              onClick={() => {
                if (!window.confirm(t.tasks.deleteConfirm(task.title))) return;
                void mutate("delete", { taskId: task.id }, { kind: "remove", id: task.id });
                onDeleted();
              }}
              className="ml-auto inline-flex items-center gap-1 text-muted hover:text-danger-text"
            >
              <Trash2 className="size-3.5" aria-hidden />
              {t.tasks.delete}
            </button>
          </div>
          {task.dueDate && task.dueDate < today && !done && (
            <span className="sr-only">{t.tasks.overdue}</span>
          )}
        </div>
      </aside>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-muted hover:bg-active hover:text-fg disabled:opacity-30"
    >
      {children}
    </button>
  );
}
