"use client";

import { CalendarClock, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { RunView, ScheduleView } from "@/application/schedules-service";
import { EmptyState } from "@/components/shared/page";
import { Button, buttonVariants } from "@/components/ui/button";
import { PRESETS, presetOf } from "@/core/schedules/presets";
import type { ScheduleInput } from "@/core/schedules/schedule";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  cancelRunAction,
  deleteScheduleAction,
  historyAction,
  pauseScheduleAction,
  runNowAction,
  type ScheduleActionResult,
} from "./actions";
import { warningText } from "./brief-view";
import { describeInstant, describeWhen } from "./format";
import { blankTask, presetTask, ScheduleForm } from "./schedule-form";

const ACTIVE_RUN = new Set(["queued", "running", "waiting_for_approval"]);
const ATTENTION = new Set(["AUTH_EXPIRED", "PERMISSION_DENIED", "CAPABILITY_UNAVAILABLE"]);

export function SchedulesView({
  schedules,
  workspaceId,
  timezone,
  spaces,
  methods = [],
  backgroundAvailable,
  draft,
}: {
  /** Methods a task can follow (ADR-040 §O). */
  methods?: { id: string; name: string }[];
  schedules: ScheduleView[];
  workspaceId: string;
  timezone: string;
  /** Knowledge Spaces, for tasks that summarize one. */
  spaces: { id: string; path: string }[];
  backgroundAvailable: boolean;
  /** A proposal from chat opened for editing. */
  draft: ScheduleInput | null;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [editing, setEditing] = useState<{ id?: string; input: ScheduleInput } | null>(
    draft ? { input: draft } : null,
  );
  useRealtimeRefresh(workspaceId, ["schedules", "schedule_runs", "scheduled_results"]);
  // A preset already in use opens that schedule instead of creating a second one (ADR-037).
  const byPreset = new Map(
    schedules.flatMap((s) => {
      const preset = presetOf(s.input.configuration);
      return preset ? [[preset, s] as const] : [];
    }),
  );

  const done = () => {
    setEditing(null);
    router.replace("/schedules");
    router.refresh();
  };
  const open = (next: { id?: string; input: ScheduleInput }) => {
    setEditing(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="flex flex-col gap-6">
      {!backgroundAvailable && (
        <p className="rounded-2xl border border-dashed border-border px-5 py-3.5 text-[13.5px] text-muted">
          {t.schedules.notConfigured}
        </p>
      )}
      {editing ? (
        <ScheduleForm
          key={editing.id ?? editing.input.configuration.preset ?? "new"}
          initial={editing.input}
          scheduleId={editing.id}
          spaces={spaces}
          methods={methods}
          onDone={done}
        />
      ) : (
        <div className="flex justify-end">
          <Button onClick={() => open({ input: blankTask(timezone) })}>
            <Plus />
            {t.schedules.create}
          </Button>
        </div>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">{t.schedules.yours}</h2>
        {schedules.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={t.schedules.emptyTitle}
            body={t.schedules.emptyBody}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {schedules.map((s) => (
              <li key={s.id}>
                <ScheduleCard
                  schedule={s}
                  backgroundAvailable={backgroundAvailable}
                  onEdit={() => open({ id: s.id, input: s.input })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 border-t border-border pt-6">
        <div className="flex flex-col gap-1">
          <h2 className="type-label text-faint">{t.schedules.ideas}</h2>
          <p className="text-[13px] text-muted">{t.schedules.ideasHint}</p>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {PRESETS.map((p) => {
            const text = t.schedules.presets[p.id];
            const existing = byPreset.get(p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() =>
                    open(
                      existing
                        ? { id: existing.id, input: existing.input }
                        : { input: presetTask(p.id, timezone, text) },
                    )
                  }
                  className="flex h-full w-full flex-col items-start gap-1 rounded-2xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-accent/50"
                >
                  <span className="flex w-full items-baseline justify-between gap-2">
                    <span className="text-[14.5px] font-medium">{text.name}</span>
                    {existing && (
                      <span className="shrink-0 text-[12px] text-success">
                        ✓ {t.schedules.alreadyAdded}
                      </span>
                    )}
                  </span>
                  <span className="text-[12.5px] text-faint">
                    {describeWhen(p.definition, t, locale)}
                  </span>
                  <span className="text-[13px] text-muted">{text.purpose}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function ScheduleCard({
  schedule: s,
  backgroundAvailable,
  onEdit,
}: {
  schedule: ScheduleView;
  backgroundAvailable: boolean;
  onEdit: () => void;
}) {
  const { t, locale } = useI18n();
  const [pending, startTransition] = useTransition();
  const [history, setHistory] = useState<RunView[] | null>(null);
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const running = starting || (s.lastRun !== null && ACTIVE_RUN.has(s.lastRun.status));

  /**
   * Run now (ADR-041 §K): the run is a conversation ELISE starts. Once it's ready, it opens on
   * the Live Canvas, where the user keeps talking with it.
   */
  function runNow() {
    startTransition(async () => {
      const started = await runNowAction(s.id);
      if (!started.ok) return void toast.error(errorText(t, started.error));
      toast.success(t.schedules.started);
      setStarting(true);
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        const runs = await historyAction(s.id);
        const run = runs.ok ? runs.value.find((r) => r.id === started.value) : null;
        if (!run || ACTIVE_RUN.has(run.status)) continue;
        setStarting(false);
        if (run.resultId) return router.push(`/schedules/results/${run.resultId}`);
        router.refresh();
        return;
      }
      setStarting(false);
      router.refresh();
    });
  }
  const attention = s.lastRun?.warnings.find((w) => ATTENTION.has(w.code));

  function act<T>(fn: () => Promise<ScheduleActionResult<T>>, success?: string) {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) toast.error(errorText(t, result.error));
      else if (success) toast.success(success);
    });
  }

  const status = running
    ? { label: t.schedules.status.running, dot: "bg-accent animate-pulse" }
    : attention
      ? { label: t.schedules.status.needs_attention, dot: "bg-approval" }
      : s.status === "active"
        ? { label: t.schedules.status.active, dot: "bg-success" }
        : { label: t.schedules.status[s.status], dot: "bg-faint" };

  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-base font-medium">{s.name}</p>
          <p className="text-[13.5px] text-muted">
            {describeWhen(s.definition, t, locale)}
            {s.nextRunAt && (
              <span className="text-faint">
                {" · "}
                {t.schedules.next(describeInstant(s.nextRunAt, s.timezone, t, locale))}
              </span>
            )}
          </p>
        </div>
        <span className="flex h-7 items-center gap-2 text-[13px] text-muted">
          <span aria-hidden className={cn("size-1.5 rounded-full", status.dot)} />
          {status.label}
        </span>
      </header>

      {attention && (
        <p className="flex flex-wrap items-center gap-x-3 text-[13px] text-approval-text">
          {warningText(attention, t)}
          <Link href="/connections" className="underline">
            {t.brief.reconnect}
          </Link>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {running ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => act(() => cancelRunAction(s.id))}
          >
            {t.schedules.cancelRun}
          </Button>
        ) : (
          <Button size="sm" disabled={pending || !backgroundAvailable} onClick={runNow}>
            {t.schedules.runNow}
          </Button>
        )}
        {s.status === "paused" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => act(() => pauseScheduleAction(s.id, false))}
          >
            {t.schedules.resume}
          </Button>
        ) : s.status === "active" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => act(() => pauseScheduleAction(s.id, true))}
          >
            {t.schedules.pause}
          </Button>
        ) : null}
        {s.lastRun?.resultId && (
          <Link
            href={`/schedules/results/${s.lastRun.resultId}`}
            className={buttonVariants({ size: "sm", variant: "secondary" })}
          >
            {t.schedules.openLatest}
          </Link>
        )}
        <Button size="sm" variant="ghost" disabled={pending} onClick={onEdit}>
          {t.schedules.edit}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={history !== null}
          onClick={() =>
            history
              ? setHistory(null)
              : startTransition(async () => {
                  const result = await historyAction(s.id);
                  if (result.ok) setHistory(result.value);
                })
          }
        >
          {t.schedules.history}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          className="ml-auto hover:text-danger-text"
          onClick={() => {
            if (window.confirm(t.schedules.deleteConfirm(s.name)))
              act(() => deleteScheduleAction(s.id));
          }}
        >
          {t.schedules.delete}
        </Button>
      </div>

      {history && <History runs={history} timezone={s.timezone} />}
    </article>
  );
}

const MARK: Record<string, { icon: string; className: string }> = {
  completed: { icon: "✓", className: "text-success" },
  completed_with_warning: { icon: "⚠", className: "text-approval-text" },
  failed: { icon: "✕", className: "text-danger-text" },
};

function History({ runs, timezone }: { runs: RunView[]; timezone: string }) {
  const { t, locale } = useI18n();
  if (runs.length === 0) return <p className="text-[13px] text-faint">{t.schedules.noRuns}</p>;
  return (
    <ol className="flex flex-col divide-y divide-border border-t border-border pt-1">
      {runs.map((r) => {
        const mark = MARK[r.status] ?? { icon: "·", className: "text-faint" };
        return (
          <li
            key={r.id}
            className="grid grid-cols-[120px_minmax(0,1fr)_auto] items-baseline gap-3 py-2 text-[13.5px]"
          >
            <span className="font-mono text-[12.5px] text-muted">
              {describeInstant(r.scheduledFor, timezone, t, locale)}
            </span>
            <span className="min-w-0 truncate">
              <span aria-hidden className={cn("mr-2", mark.className)}>
                {mark.icon}
              </span>
              {t.schedules.runs[r.status]}
              {r.errorCode && r.status === "failed" && (
                <span className="ml-2 text-faint">
                  {t.errors.codes[r.errorCode as keyof typeof t.errors.codes] ?? r.errorCode}
                </span>
              )}
            </span>
            {r.resultId ? (
              <Link
                href={`/schedules/results/${r.resultId}`}
                className="text-[13px] text-accent-text"
              >
                {t.schedules.open}
              </Link>
            ) : (
              <span />
            )}
          </li>
        );
      })}
    </ol>
  );
}
