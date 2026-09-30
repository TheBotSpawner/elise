"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import type { GoalView } from "@/application/native-service";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import type { ProgressMode, ProgressType } from "@/core/capabilities/goals";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { ImportPanel } from "./import-panel";
import { useNative } from "./use-native";

type Linkable = { habits: { id: string; name: string }[]; tasks: { id: string; name: string }[] };

function NewGoal({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const { act, pending } = useNative();
  const [title, setTitle] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [type, setType] = useState<ProgressType>("binary");
  const [mode, setMode] = useState<ProgressMode>("manual");
  const [current, setCurrent] = useState("");
  const [target, setTarget] = useState("");
  const [metric, setMetric] = useState("");
  const [decrease, setDecrease] = useState(false);
  const n = (v: string) => (v.trim() ? Number(v.replace(",", ".")) : undefined);
  return (
    <form
      className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5"
      onSubmit={(e) => {
        e.preventDefault();
        act(
          "goals.create",
          {
            title,
            progressType: type,
            progressMode: mode,
            ...(targetDate ? { targetDate } : {}),
            ...(type !== "binary" && n(current) !== undefined ? { currentValue: n(current) } : {}),
            ...(type === "numeric" && n(target) !== undefined ? { targetValue: n(target) } : {}),
            ...(type === "numeric" && n(current) !== undefined ? { startValue: n(current) } : {}),
            ...(type === "numeric" && metric.trim() ? { metric: metric.trim() } : {}),
            ...(type === "numeric" ? { direction: decrease ? "decrease" : "increase" } : {}),
          },
          onDone,
        );
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="goal-title">{t.native.goals.titleLabel}</Label>
        <Input
          id="goal-title"
          autoFocus
          required
          maxLength={300}
          value={title}
          placeholder={t.native.goals.titlePlaceholder}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="goal-date">{t.native.goals.targetDate}</Label>
          <Input
            id="goal-date"
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="goal-type">{t.native.goals.type}</Label>
          <Select
            id="goal-type"
            value={type}
            onChange={(e) => setType(e.target.value as ProgressType)}
          >
            {(["binary", "numeric", "percentage"] as const).map((v) => (
              <option key={v} value={v}>
                {t.native.goals.types[v]}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="goal-mode">{t.native.goals.mode}</Label>
          <Select
            id="goal-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as ProgressMode)}
          >
            {(["manual", "linked", "hybrid"] as const).map((v) => (
              <option key={v} value={v}>
                {t.native.goals.modes[v]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {type === "numeric" && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Input
            aria-label={t.native.goals.current}
            placeholder={t.native.goals.current}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
          <Input
            aria-label={t.native.goals.target}
            placeholder={t.native.goals.target}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <Input
            aria-label={t.native.goals.metric}
            placeholder={t.native.goals.metric}
            value={metric}
            maxLength={60}
            onChange={(e) => setMetric(e.target.value)}
          />
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={decrease}
              onChange={(e) => setDecrease(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            {t.native.goals.lowerIsBetter}
          </label>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t.native.cancel}
        </Button>
        <Button type="submit" disabled={pending || !title.trim()}>
          {t.native.create}
        </Button>
      </div>
    </form>
  );
}

function GoalCard({ view, linkable }: { view: GoalView; linkable: Linkable }) {
  const { t, locale } = useI18n();
  const { act, pending } = useNative();
  const { goal, progress } = view;
  const [value, setValue] = useState(goal.currentValue?.toString() ?? "");
  const percent = progress.percent;
  const date = goal.targetDate
    ? new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${goal.targetDate}T00:00:00Z`))
    : null;
  const linkedIds = new Set(goal.links.map((l) => l.resourceId));

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4",
        goal.status !== "active" && "opacity-70",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-medium">{goal.title}</p>
          <p className="text-[13px] text-muted">
            {t.native.goals.status[goal.status]}
            {date && ` · ${t.native.goals.due(date)}`}
            {goal.progressType === "numeric" &&
              ` · ${goal.currentValue ?? "?"} → ${goal.targetValue ?? "?"}${goal.metric ? ` ${goal.metric}` : ""}`}
          </p>
        </div>
        <span className="font-mono text-[15px]">{percent === null ? "—" : `${percent}%`}</span>
      </div>
      {percent !== null && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-sm)]"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <p className="text-[12.5px] text-faint">{progress.basis}</p>
      {goal.links.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {goal.links.map((l) => (
            <li
              key={l.id}
              className="flex h-8 items-center gap-2 rounded-full border border-border px-3 text-[13px]"
            >
              <span className="text-faint">
                {l.resourceType === "habit"
                  ? t.native.goals.linkHabit
                  : l.resourceType === "task"
                    ? t.native.goals.linkTask
                    : l.resourceType}
              </span>
              {l.title ?? "…"}
              <button
                type="button"
                aria-label="×"
                disabled={pending}
                className="text-faint hover:text-danger-text"
                onClick={() =>
                  act("goals.unlinkResource", {
                    goal: goal.id,
                    resourceType: l.resourceType,
                    resource: l.resourceId,
                  })
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {(view.habits.length > 0 || view.openTasks.length > 0) && (
        <p className="text-[12.5px] text-muted">
          {view.habits.map((h) => `${h.name} ${h.done}/${h.goal}`).join(" · ")}
          {view.habits.length > 0 && view.openTasks.length > 0 && " · "}
          {view.openTasks.length > 0 && t.native.goals.openTasks(view.openTasks.length)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {goal.progressType !== "binary" && goal.status === "active" && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(value.replace(",", "."));
              if (Number.isFinite(n)) act("goals.update", { goal: goal.id, currentValue: n });
            }}
          >
            <Input
              aria-label={t.native.goals.current}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-8 w-24"
            />
            <Button size="sm" variant="secondary" type="submit" disabled={pending}>
              {t.native.goals.updateValue}
            </Button>
          </form>
        )}
        <Select
          aria-label={t.native.goals.link}
          value=""
          className="h-8 w-auto text-[13px]"
          onChange={(e) => {
            const [type, id] = e.target.value.split(":");
            if (type && id)
              act("goals.linkResource", { goal: goal.id, resourceType: type, resource: id });
          }}
        >
          <option value="">{t.native.goals.link}</option>
          {linkable.habits
            .filter((h) => !linkedIds.has(h.id))
            .map((h) => (
              <option key={h.id} value={`habit:${h.id}`}>
                {t.native.goals.linkHabit}: {h.name}
              </option>
            ))}
          {linkable.tasks
            .filter((x) => !linkedIds.has(x.id))
            .map((x) => (
              <option key={x.id} value={`task:${x.id}`}>
                {t.native.goals.linkTask}: {x.name}
              </option>
            ))}
        </Select>
        <span className="ml-auto flex gap-1">
          {goal.status === "active" ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => act("goals.complete", { goal: goal.id })}
              >
                {t.native.goals.complete}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => act("goals.pause", { goal: goal.id })}
              >
                {t.native.goals.pause}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => act("goals.update", { goal: goal.id, status: "active" })}
            >
              {t.native.goals.resume}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="hover:text-danger-text"
            disabled={pending}
            onClick={() => {
              if (window.confirm(t.native.archiveConfirm(goal.title)))
                act("goals.archive", { goal: goal.id });
            }}
          >
            {t.native.archive}
          </Button>
        </span>
      </div>
    </li>
  );
}

export function GoalsView({
  goals,
  linkable,
  workspaceId,
}: {
  goals: GoalView[];
  linkable: Linkable;
  workspaceId: string;
}) {
  const { t } = useI18n();
  const [panel, setPanel] = useState<"new" | "import" | null>(null);
  useRealtimeRefresh(workspaceId, ["goals", "goal_links", "habit_entries", "tasks"]);
  const order = { active: 0, paused: 1, completed: 2, cancelled: 3 } as const;
  const sorted = [...goals].sort((a, b) => order[a.goal.status] - order[b.goal.status]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setPanel(panel === "import" ? null : "import")}>
          {t.native.importCsv}
        </Button>
        <Button onClick={() => setPanel(panel === "new" ? null : "new")}>
          <Plus />
          {t.native.goals.new}
        </Button>
      </div>
      {panel === "new" && <NewGoal onDone={() => setPanel(null)} />}
      {panel === "import" && <ImportPanel kind="goals" onDone={() => setPanel(null)} />}
      {sorted.length === 0 ? (
        <p className="text-[14px] text-muted">{t.native.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sorted.map((v) => (
            <GoalCard key={v.goal.id} view={v} linkable={linkable} />
          ))}
        </ul>
      )}
    </div>
  );
}
