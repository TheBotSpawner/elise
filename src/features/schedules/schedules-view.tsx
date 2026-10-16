"use client";

import {
  CalendarClock,
  ExternalLink,
  History as HistoryIcon,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createElement, useState, useTransition } from "react";
import { toast } from "sonner";

import type { RunView, ScheduleView } from "@/application/schedules-service";
import { EmptyState } from "@/components/shared/page";
import { Button } from "@/components/ui/button";
import { ChipRail, OverflowMenu, type MenuAction } from "@/components/ui/sheet-menu";
import { PRESETS, presetOf } from "@/core/schedules/presets";
import type { BriefBlock, ScheduleInput } from "@/core/schedules/schedule";
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
import { BLOCK_ICONS, PRESET_ICONS, scheduleIcon } from "./icons";
import { blankTask, presetTask, ScheduleEditor } from "./schedule-form";

const ACTIVE_RUN = new Set(["queued", "running", "waiting_for_approval"]);
const ATTENTION = new Set(["AUTH_EXPIRED", "PERMISSION_DENIED", "CAPABILITY_UNAVAILABLE"]);

type Filter = "all" | "active" | "paused";

/**
 * Scheduled hub (ADR-037, ADR-067): your tasks and the ideas side by side on wide screens,
 * stacked on phones. Creating and editing happen in a modal (a full-screen sheet on phones),
 * never inline above the list.
 */
export function SchedulesView({
  schedules,
  workspaceId,
  timezone,
  spaces,
  slackWorkspaces = [],
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
  /** Connected Slack workspaces, for briefs that read some of their channels. */
  slackWorkspaces?: { id: string; name: string }[];
  backgroundAvailable: boolean;
  /** A proposal from chat opened for editing. */
  draft: ScheduleInput | null;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [editing, setEditing] = useState<{ id?: string; input: ScheduleInput } | null>(
    draft ? { input: draft } : null,
  );
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  useRealtimeRefresh(workspaceId, ["schedules", "schedule_runs", "scheduled_results"]);
  // A preset already in use opens that schedule instead of creating a second one (ADR-037).
  const byPreset = new Map(
    schedules.flatMap((s) => {
      const preset = presetOf(s.input.configuration);
      return preset ? [[preset, s] as const] : [];
    }),
  );
  const methodName = new Map(methods.map((m) => [m.id, m.name]));

  const close = () => {
    setEditing(null);
    if (draft) router.replace("/schedules");
  };
  const saved = () => {
    setEditing(null);
    router.replace("/schedules");
    router.refresh();
  };
  const counts: Record<Filter, number> = {
    all: schedules.length,
    active: schedules.filter((s) => s.status === "active").length,
    paused: schedules.filter((s) => s.status === "paused").length,
  };
  const needle = query.trim().toLowerCase();
  const shown = schedules.filter(
    (s) =>
      (filter === "all" || s.status === filter) &&
      (!needle ||
        s.name.toLowerCase().includes(needle) ||
        (s.input.instructions ?? "").toLowerCase().includes(needle)),
  );

  return (
    <div className="flex flex-col gap-6">
      {!backgroundAvailable && (
        <p className="rounded-2xl border border-dashed border-border px-5 py-3.5 text-[13.5px] text-muted">
          {t.schedules.notConfigured}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {schedules.length > 1 && (
          <ChipRail label={t.common.filters} className="md:flex-wrap">
            {(["all", "active", "paused"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "h-9 shrink-0 rounded-full border px-3.5 text-[13px] transition-colors",
                  filter === f
                    ? "border-accent/50 bg-accent-soft text-accent-text"
                    : "border-border text-muted hover:text-fg",
                )}
              >
                {t.schedules.filters[f]}
                <span className="ml-1.5 font-mono text-[11px] opacity-70">{counts[f]}</span>
              </button>
            ))}
          </ChipRail>
        )}
        {schedules.length > 4 && (
          <label className="relative max-md:w-full">
            <span className="sr-only">{t.schedules.search}</span>
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
            />
            <input
              type="search"
              value={query}
              placeholder={t.schedules.search}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 w-full rounded-full border border-border bg-transparent pr-3 pl-9 text-[13.5px] placeholder:text-faint focus:border-accent focus:outline-none md:w-60"
            />
          </label>
        )}
        <Button
          onClick={() => setEditing({ input: blankTask(timezone) })}
          className="ml-auto max-md:w-full"
        >
          <Plus />
          {t.schedules.create}
        </Button>
      </div>

      {/* Wide screens: your tasks and the templates side by side, using the width. */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
        <section className="flex flex-col gap-3">
          <h2 className="type-label text-faint">{t.schedules.yours}</h2>
          {schedules.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title={t.schedules.emptyTitle}
              body={t.schedules.emptyBody}
            />
          ) : shown.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border px-5 py-6 text-center text-[13.5px] text-muted">
              {t.schedules.noMatches}
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {shown.map((s) => (
                <li key={s.id}>
                  <ScheduleCard
                    schedule={s}
                    methodName={
                      s.input.configuration.methodId
                        ? (methodName.get(s.input.configuration.methodId) ?? null)
                        : null
                    }
                    backgroundAvailable={backgroundAvailable}
                    onEdit={() => setEditing({ id: s.id, input: s.input })}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-3 max-lg:border-t max-lg:border-border max-lg:pt-6">
          <div className="flex flex-col gap-1">
            <h2 className="type-label text-faint">{t.schedules.ideas}</h2>
            <p className="text-[13px] text-muted">{t.schedules.ideasHint}</p>
          </div>
          {/* Phones (ADR-066): a swipeable rail of compact ideas, not a long list of cards. */}
          <ul className="-mx-4 no-scrollbar flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0">
            {PRESETS.map((p) => {
              const text = t.schedules.presets[p.id];
              const existing = byPreset.get(p.id);
              const Icon = PRESET_ICONS[p.id];
              return (
                <li key={p.id} className="w-[78%] shrink-0 snap-start sm:w-auto">
                  <button
                    type="button"
                    onClick={() =>
                      setEditing(
                        existing
                          ? { id: existing.id, input: existing.input }
                          : { input: presetTask(p.id, timezone, text) },
                      )
                    }
                    className="group flex h-full w-full flex-col items-start gap-1.5 rounded-2xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent/50"
                  >
                    <span className="mb-1 flex w-full items-center justify-between gap-2">
                      <span className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent-text">
                        <Icon className="size-4" strokeWidth={1.6} aria-hidden />
                      </span>
                      {existing ? (
                        <span className="text-[12px] text-success">
                          ✓ {t.schedules.alreadyAdded}
                        </span>
                      ) : (
                        <span className="text-[12px] text-accent-text opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100">
                          {p.needsSpace ? t.schedules.configure : t.schedules.add}
                        </span>
                      )}
                    </span>
                    <span className="text-[14.5px] font-medium">{text.name}</span>
                    <span className="text-[12.5px] text-faint">
                      {describeWhen(p.definition, t, locale)}
                    </span>
                    <span className="line-clamp-2 text-[13px] text-muted">{text.purpose}</span>
                    <BlockChips blocks={p.blocks} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <ScheduleEditor
        editing={editing}
        spaces={spaces}
        slackWorkspaces={slackWorkspaces}
        methods={methods}
        onClose={close}
        onSaved={saved}
      />
    </div>
  );
}

/** What a task looks at, as small icon chips — never the whole checklist. */
function BlockChips({ blocks }: { blocks: readonly BriefBlock[] }) {
  const { t } = useI18n();
  return (
    <span className="mt-auto flex flex-wrap gap-1 pt-1">
      {blocks.map((b) => {
        const Icon = BLOCK_ICONS[b];
        return (
          <span
            key={b}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-[11.5px] text-muted"
          >
            <Icon className="size-3" strokeWidth={1.6} aria-hidden />
            {t.schedules.blockShort[b]}
          </span>
        );
      })}
    </span>
  );
}

function ScheduleCard({
  schedule: s,
  methodName,
  backgroundAvailable,
  onEdit,
}: {
  schedule: ScheduleView;
  methodName: string | null;
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
  const toggleHistory = () =>
    history
      ? setHistory(null)
      : startTransition(async () => {
          const result = await historyAction(s.id);
          if (result.ok) setHistory(result.value);
        });
  const remove = () => {
    if (window.confirm(t.schedules.deleteConfirm(s.name))) act(() => deleteScheduleAction(s.id));
  };

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

  // One primary action; the rest behind ⋯, destructive last (ADR-067).
  const pause: MenuAction[] =
    s.status === "paused"
      ? [
          {
            label: t.schedules.resume,
            icon: Play,
            onClick: () => act(() => pauseScheduleAction(s.id, false)),
          },
        ]
      : s.status === "active"
        ? [
            {
              label: t.schedules.pause,
              icon: Pause,
              onClick: () => act(() => pauseScheduleAction(s.id, true)),
            },
          ]
        : [];
  const more: MenuAction[] = [
    ...pause,
    { label: t.schedules.edit, icon: Pencil, onClick: onEdit },
    ...(s.lastRun?.resultId
      ? [
          {
            label: t.schedules.openLatest,
            icon: ExternalLink,
            href: `/schedules/results/${s.lastRun.resultId}`,
          },
        ]
      : []),
    { label: t.schedules.history, icon: HistoryIcon, onClick: toggleHistory },
    { label: t.schedules.delete, icon: Trash2, onClick: remove, danger: true },
  ];
  const last = s.lastRun;

  return (
    <article
      className={cn(
        "flex flex-col gap-3.5 rounded-2xl border border-border bg-surface p-4 md:p-5",
        s.status === "paused" && "opacity-80",
      )}
    >
      <header className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
          {createElement(scheduleIcon(s.input), {
            className: "size-5",
            strokeWidth: 1.6,
            "aria-hidden": true,
          })}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15.5px] font-medium">{s.name}</p>
          <p className="text-[13px] text-muted">
            {describeWhen(s.definition, t, locale)}
            {s.nextRunAt && (
              <span className="text-faint">
                {" · "}
                {t.schedules.next(describeInstant(s.nextRunAt, s.timezone, t, locale))}
              </span>
            )}
          </p>
        </div>
        <span className="flex h-7 shrink-0 items-center gap-2 text-[13px] text-muted">
          <span aria-hidden className={cn("size-1.5 rounded-full", status.dot)} />
          {status.label}
        </span>
      </header>

      {s.input.instructions && (
        <p className="line-clamp-2 text-[13px] text-fg2">{s.input.instructions}</p>
      )}

      <div className="flex flex-wrap items-end gap-1">
        <BlockChips blocks={s.input.configuration.blocks} />
        {methodName && (
          <span className="inline-flex h-6 items-center rounded-full border border-accent-line px-2 text-[11.5px] text-accent-text">
            {t.schedules.method(methodName)}
          </span>
        )}
      </div>

      {attention && (
        <p className="flex flex-wrap items-center gap-x-3 text-[13px] text-approval-text">
          {warningText(attention, t)}
          <Link href="/connections" className="underline">
            {t.brief.reconnect}
          </Link>
        </p>
      )}

      <footer className="flex items-center gap-2 border-t border-border pt-3">
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
        {last && !running && (
          <span className="min-w-0 truncate text-[12px] text-faint max-sm:hidden">
            {t.schedules.lastRun(
              t.schedules.runs[last.status],
              describeInstant(last.completedAt ?? last.scheduledFor, s.timezone, t, locale),
            )}
          </span>
        )}
        <OverflowMenu label={t.common.moreActions} items={more} className="ml-auto" />
      </footer>

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
