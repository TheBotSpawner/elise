"use client";

import { ChevronDown, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { GoalsWorkspace } from "@/application/native-service";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import type { Goal, Vision } from "@/core/capabilities/goals";
import {
  filterGoals,
  goalCard,
  goalsSummary,
  GOAL_SORTS,
  PERIOD_FILTERS,
  periodFilterRange,
  periodWindow,
  sortGoals,
  visionIdsOf,
  type GoalDetail,
  type GoalSnapshot,
  type GoalSort,
  type GoalStatusFilter,
  type PeriodFilter,
} from "@/core/goals/analytics";
import { daysBetween, periodLabel } from "@/core/goals/periods";
import type { VisualizationSpec } from "@/core/workspace/visualization";
import { Visualization } from "@/features/workspace/viz/visualization";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { goalDetailAction } from "./actions";
import { GoalDialog, ProgressEditor, VisionDialog, type GoalOptions } from "./goal-form";
import {
  GoalSummary,
  HabitChips,
  HealthBadge,
  ProgressRing,
  ringTone,
  useGoalFormat,
  VisionIcon,
} from "./goal-parts";
import { ImportPanel } from "./import-panel";
import { Bar, IconTile, Menu } from "./native-ui";
import { useNative } from "./use-native";

/**
 * My Elise → Goals (ADR-055): Visions across the top, goals as scannable cards, a side column
 * with the summary or the selected goal / Vision. Every number comes from core/goals, computed
 * once on the server (the same tool Chat uses); filtering and sorting run here instantly.
 */

const TABS: GoalStatusFilter[] = ["active", "at_risk", "completed", "all"];

function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-2xl border border-border bg-surface px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="type-label text-faint">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

// ── Visions ──────────────────────────────────────────────────────────────────

function VisionCard({
  summary,
  selected,
  onOpen,
}: {
  summary: GoalsWorkspace["visions"][number];
  selected: boolean;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const g = t.native.goals;
  const v = summary.vision;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={selected}
      className={cn(
        "flex min-w-[15rem] flex-col gap-2 rounded-2xl border bg-surface px-4 py-3.5 text-left transition-colors hover:border-accent-line focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
        selected ? "border-accent-line" : "border-border",
        v.status !== "active" && "opacity-75",
      )}
    >
      <span className="flex items-center gap-2.5">
        <IconTile icon={v.icon} size="sm" />
        <span className="line-clamp-2 min-w-0 flex-1 text-[13.5px] leading-snug font-medium">
          {v.title}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
        <span>{g.visionCounts(summary.active, summary.completed)}</span>
        {summary.atRisk > 0 && (
          <span className="text-approval-text">
            · {summary.atRisk} {g.health.at_risk.toLowerCase()}
          </span>
        )}
        {v.status !== "active" && <span>· {g.visionStatus[v.status]}</span>}
      </span>
    </button>
  );
}

// ── Goal detail ──────────────────────────────────────────────────────────────

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-surface-2/60 px-3 py-2">
      <span className="text-[11.5px] text-muted">{label}</span>
      <span className="truncate text-[13.5px]">{children}</span>
    </div>
  );
}

function GoalDetailPanel({
  snapshot,
  visionTitles,
  onClose,
  onEdit,
  onProgress,
  onOpenGoal,
  version,
}: {
  snapshot: GoalSnapshot;
  visionTitles: Map<string, string>;
  onClose: () => void;
  onEdit: () => void;
  onProgress: (el: HTMLElement) => void;
  onOpenGoal: (id: string) => void;
  /** Changes when the page data changes: the detail reloads its history then. */
  version: unknown;
}) {
  const { t } = useI18n();
  const g = t.native.goals;
  const d = g.detail;
  const m = g.menu;
  const fmt = useGoalFormat();
  const { act, pending } = useNative();
  const goal = snapshot.goal;
  const card = goalCard(snapshot, visionTitles);
  const [detail, setDetail] = useState<GoalDetail | null>(null);
  useEffect(() => {
    let live = true;
    void goalDetailAction(goal.id).then((r) => live && r.ok && setDetail(r.value));
    return () => {
      live = false;
    };
  }, [goal.id, version]);

  const active = goal.status === "active" && !goal.archived;
  const menu = goal.archived
    ? [{ label: m.restore, onClick: () => act("goals.restore", { goal: goal.id }) }]
    : [
        goal.status === "paused"
          ? {
              label: m.resume,
              onClick: () => act("goals.update", { goal: goal.id, status: "active" }),
            }
          : goal.status === "active"
            ? { label: m.pause, onClick: () => act("goals.pause", { goal: goal.id }) }
            : {
                label: m.reopen,
                onClick: () => act("goals.update", { goal: goal.id, status: "active" }),
              },
        {
          label: m.archive,
          onClick: () =>
            window.confirm(t.native.archiveConfirm(goal.title)) &&
            act("goals.archive", { goal: goal.id }, onClose),
        },
      ];
  menu.push({
    label: m.delete,
    danger: true,
    onClick: () =>
      window.confirm(g.deleteConfirm(goal.title)) &&
      act("goals.delete", { goal: goal.id }, onClose),
  } as (typeof menu)[number]);

  const history = detail?.history ?? [];
  const trend: VisualizationSpec | null =
    history.length >= 2
      ? ({
          type: "line",
          title: "",
          format: card.currency
            ? { kind: "currency", currency: card.currency }
            : { kind: "number" },
          x: history.map((h) => fmt.day(h.date).replace(/ \d{4}$/, "")),
          series: [{ name: card.unit ?? d.progress, values: history.map((h) => h.value) }],
          ...(card.target !== null && card.progressType === "numeric"
            ? { target: { value: card.target, label: d.target } }
            : {}),
        } as VisualizationSpec)
      : null;
  const period = fmt.period(card.periodFrom, card.periodTo);

  return (
    <section
      aria-label={goal.title}
      className="flex flex-col gap-4 rounded-2xl border border-border-strong bg-surface p-4 max-xl:fixed max-xl:inset-0 max-xl:z-40 max-xl:overflow-y-auto max-xl:rounded-none max-xl:pb-10"
    >
      <div className="flex items-start gap-3">
        <IconTile icon={card.icon} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] leading-snug font-medium">{goal.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <HealthBadge state={card.health} reached={card.reached && active} />
            {card.area && <span className="text-[12px] text-muted">{card.area}</span>}
          </div>
        </div>
        <Menu label={m.label(goal.title)} items={menu} />
        <button
          type="button"
          aria-label={d.close}
          onClick={onClose}
          className="grid size-8 place-items-center rounded-full text-muted hover:bg-active"
        >
          <X className="size-4" />
        </button>
      </div>
      {card.health === "at_risk" && fmt.reason(card) && (
        <p className="-mt-1 rounded-xl bg-approval-bg px-3 py-2 text-[12.5px] text-approval-text">
          {fmt.reason(card)}
        </p>
      )}
      {card.reached && active && (
        <div className="-mt-1 flex items-center justify-between gap-2 rounded-xl bg-success/12 px-3 py-2 text-[12.5px]">
          <span>{g.reachedHint}</span>
          <Button
            size="sm"
            disabled={pending}
            onClick={() => act("goals.complete", { goal: goal.id })}
          >
            {m.complete}
          </Button>
        </div>
      )}

      <div className="flex items-center gap-4">
        <ProgressRing percent={card.percent} size={76} tone={ringTone(card)} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-[20px]">{fmt.value(card) || g.health[card.health]}</span>
          <span className="text-[12.5px] text-muted">{d.basis[card.basis]}</span>
          {snapshot.progress.linkedValue !== null && card.basis === "hybrid" && (
            <span className="text-[12px] text-faint">
              {g.progress.linkedPart(fmt.number(snapshot.progress.linkedValue))}
            </span>
          )}
        </div>
      </div>
      {active && (
        <div className="flex flex-wrap gap-2">
          {goal.progressType !== "binary" && (
            <Button size="sm" variant="secondary" onClick={(e) => onProgress(e.currentTarget)}>
              {g.progress.update}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onEdit}>
            {m.edit}
          </Button>
          {!card.reached && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => act("goals.complete", { goal: goal.id })}
            >
              {m.complete}
            </Button>
          )}
        </div>
      )}
      {!active && !goal.archived && (
        <Button size="sm" variant="secondary" className="self-start" onClick={onEdit}>
          {m.edit}
        </Button>
      )}

      <div className="grid grid-cols-2 gap-2">
        {card.target !== null && card.progressType === "numeric" && (
          <Fact label={d.target}>
            {fmt.amount(card.target, card)} {card.currency ? "" : (card.unit ?? "")}
          </Fact>
        )}
        {period && <Fact label={d.period}>{period}</Fact>}
        {card.deadline && <Fact label={d.deadline}>{fmt.day(card.deadline)}</Fact>}
        {card.completedAt && (
          <Fact label={g.health.completed}>{fmt.day(card.completedAt.slice(0, 10))}</Fact>
        )}
      </div>
      {goal.description && (
        <p className="text-[13.5px] whitespace-pre-wrap text-muted">{goal.description}</p>
      )}

      {detail?.visions.length ||
      detail?.parent ||
      detail?.children.length ||
      detail?.related.length ? (
        <div className="flex flex-col gap-2 text-[13px]">
          {detail.visions.length > 0 && (
            <p>
              <span className="text-muted">{d.visions}: </span>
              {detail.visions.map((v) => `${v.icon ?? ""} ${v.title}`.trim()).join(" · ")}
            </p>
          )}
          {detail.parent && (
            <p>
              <span className="text-muted">{d.parent}: </span>
              <button
                type="button"
                className="hover:text-accent-text"
                onClick={() => onOpenGoal(detail.parent!.id)}
              >
                {detail.parent.icon} {detail.parent.title}
              </button>
            </p>
          )}
          {detail.children.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted">{d.children}</span>
              {detail.children.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onOpenGoal(c.id)}
                  className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 text-left hover:text-accent-text"
                >
                  <span className="truncate">
                    {c.icon} {c.title}
                  </span>
                  <Bar value={c.percent === null ? null : c.percent / 100} />
                </button>
              ))}
            </div>
          )}
          {detail.related.length > 0 && (
            <p>
              <span className="text-muted">{d.related}: </span>
              {detail.related.map((r, i) => (
                <span key={r.id}>
                  {i > 0 && " · "}
                  <button
                    type="button"
                    className="hover:text-accent-text"
                    onClick={() => onOpenGoal(r.id)}
                  >
                    {r.title}
                  </button>
                </span>
              ))}
            </p>
          )}
        </div>
      ) : null}

      {card.habits.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="type-label text-faint">{d.habits}</h3>
          <HabitChips habits={card.habits} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="type-label text-faint">{d.history}</h3>
        {trend && <Visualization spec={trend} size="small" />}
        {!detail ? (
          <p className="text-[12px] text-faint">{d.loading}</p>
        ) : detail.events.length === 0 ? (
          <p className="text-[12px] text-faint">{d.noHistory}</p>
        ) : (
          <ol className="flex flex-col gap-1.5 text-[12.5px]">
            {detail.events.slice(0, 8).map((e) => (
              <li
                key={e.id}
                className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-baseline gap-2"
              >
                <span className="text-faint">{fmt.day(e.occurredAt.slice(0, 10))}</span>
                <span className="truncate text-muted">{e.note ?? d.sources[e.sourceType]}</span>
                <span className="font-mono">
                  {e.newValue === null ? "—" : fmt.amount(e.newValue, card)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

// ── Vision detail ────────────────────────────────────────────────────────────

function VisionDetailPanel({
  vision,
  goals,
  onClose,
  onEdit,
  onNewGoal,
  onOpenGoal,
}: {
  vision: Vision;
  goals: GoalSnapshot[];
  onClose: () => void;
  onEdit: () => void;
  onNewGoal: () => void;
  onOpenGoal: (id: string) => void;
}) {
  const { t } = useI18n();
  const g = t.native.goals;
  const d = g.detail;
  const m = g.menu;
  const { act } = useNative();
  const titles = new Map([[vision.id, vision.title]]);
  const own = goals.filter((s) => visionIdsOf(s.goal).includes(vision.id));
  const activeGoals = sortGoals(
    own.filter((s) => s.goal.status === "active" || s.goal.status === "paused"),
    "attention",
  );
  const done = own.filter((s) => s.goal.status === "completed");
  const habits = [
    ...new Map(own.flatMap((s) => s.habits).map((h) => [h.id ?? h.name, h])).values(),
  ];
  const row = (s: GoalSnapshot) => (
    <li key={s.goal.id}>
      <button
        type="button"
        onClick={() => onOpenGoal(s.goal.id)}
        className="w-full rounded-xl px-2 py-1.5 text-left hover:bg-active"
      >
        <GoalSummary card={goalCard(s, titles)} compact />
      </button>
    </li>
  );
  return (
    <section
      aria-label={vision.title}
      className="flex flex-col gap-4 rounded-2xl border border-border-strong bg-surface p-4 max-xl:fixed max-xl:inset-0 max-xl:z-40 max-xl:overflow-y-auto max-xl:rounded-none max-xl:pb-10"
    >
      <div className="flex items-start gap-3">
        <IconTile icon={vision.icon} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="type-label text-faint">{g.visions}</p>
          <h2 className="text-[16px] leading-snug font-medium">{vision.title}</h2>
          <p className="mt-1 text-[12.5px] text-muted">
            {g.visionStatus[vision.status]}
            {vision.area ? ` · ${vision.area}` : ""}
          </p>
        </div>
        <Menu
          label={m.label(vision.title)}
          items={[
            { label: m.edit, onClick: onEdit },
            vision.status === "active"
              ? {
                  label: m.achieved,
                  onClick: () =>
                    act("goals.updateVision", { vision: vision.id, status: "achieved" }),
                }
              : {
                  label: m.reactivate,
                  onClick: () => act("goals.updateVision", { vision: vision.id, status: "active" }),
                },
            ...(vision.status !== "archived"
              ? [
                  {
                    label: m.archive,
                    onClick: () =>
                      act("goals.updateVision", { vision: vision.id, status: "archived" }, onClose),
                  },
                ]
              : []),
            {
              label: m.delete,
              danger: true,
              onClick: () =>
                window.confirm(g.deleteVisionConfirm(vision.title)) &&
                act("goals.deleteVision", { vision: vision.id }, onClose),
            },
          ]}
        />
        <button
          type="button"
          aria-label={d.close}
          onClick={onClose}
          className="grid size-8 place-items-center rounded-full text-muted hover:bg-active"
        >
          <X className="size-4" />
        </button>
      </div>
      {vision.description && (
        <p className="text-[13.5px] whitespace-pre-wrap text-muted">{vision.description}</p>
      )}
      {own.length > 0 && <p className="text-[13px]">{g.visionDone(done.length, own.length)}</p>}
      <div className="flex flex-col gap-1.5">
        <h3 className="type-label text-faint">{d.activeGoals}</h3>
        {activeGoals.length ? (
          <ul className="flex flex-col gap-1">{activeGoals.map(row)}</ul>
        ) : (
          <p className="text-[12.5px] text-faint">{d.noGoals}</p>
        )}
        <Button size="sm" variant="ghost" className="self-start" onClick={onNewGoal}>
          <Plus />
          {d.addGoal}
        </Button>
      </div>
      {done.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h3 className="type-label text-faint">{d.completedGoals}</h3>
          <ul className="flex flex-col gap-1">{done.map(row)}</ul>
        </div>
      )}
      {habits.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="type-label text-faint">{d.visionHabits}</h3>
          <HabitChips
            habits={habits.map((h) => ({
              name: h.name,
              icon: h.icon ?? null,
              done: h.done,
              goal: h.goal,
              drives: Boolean(h.drives),
            }))}
          />
        </div>
      )}
    </section>
  );
}

// ── Analytics column ─────────────────────────────────────────────────────────

function Analytics({
  shown,
  visions,
}: {
  shown: GoalSnapshot[];
  visions: GoalsWorkspace["visions"];
}) {
  const { t } = useI18n();
  const g = t.native.goals;
  const live = shown.filter((s) => !s.goal.archived);
  const measured = live
    .filter(
      (s) =>
        s.goal.status === "active" &&
        s.progress.percent !== null &&
        s.health.state !== "in_progress",
    )
    .sort((a, b) => (b.progress.percent ?? 0) - (a.progress.percent ?? 0))
    .slice(0, 10);
  const byState = goalsSummary(live).byState;
  const rows = (Object.entries(byState) as [keyof typeof g.health, number][]).filter(
    ([, n]) => n > 0,
  );
  const donut: VisualizationSpec | null =
    rows.length >= 2
      ? ({
          type: "donut",
          title: "",
          format: { kind: "count" },
          rows: rows.map(([state, n]) => ({ label: g.health[state], value: n })),
        } as VisualizationSpec)
      : null;
  const byVision = visions.filter((v) => v.total > 0);
  if (!live.length) return null;
  return (
    <div className="flex flex-col gap-3">
      {measured.length > 0 && (
        <Panel title={g.charts.byGoal}>
          <ul className="flex flex-col gap-2">
            {measured.map((s) => (
              <li key={s.goal.id} className="flex flex-col gap-1 text-[13px]">
                <span className="flex justify-between gap-2">
                  <span className="truncate">
                    {s.goal.icon ? `${s.goal.icon} ` : ""}
                    {s.goal.title}
                  </span>
                  <span className="font-mono text-[12px] text-muted">{s.progress.percent}%</span>
                </span>
                <Bar value={(s.progress.percent ?? 0) / 100} flag={s.health.state === "at_risk"} />
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {donut && (
        <Panel title={g.charts.byStatus}>
          <Visualization spec={donut} size="small" />
        </Panel>
      )}
      {byVision.length > 0 && (
        <Panel title={g.charts.byVision}>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {byVision.map((v) => (
              <li key={v.vision.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {v.vision.icon ? `${v.vision.icon} ` : ""}
                  {v.vision.title}
                </span>
                <span className="shrink-0 font-mono text-[12px] text-muted">
                  {v.completed}/{v.total}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────────────────

function Timeline({
  shown,
  visions,
  today,
  onOpen,
}: {
  shown: GoalSnapshot[];
  visions: GoalsWorkspace["visions"];
  today: string;
  onOpen: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const g = t.native.goals;
  const fmt = useGoalFormat();
  const dated = shown
    .map((s) => ({ s, w: periodWindow(s.goal) }))
    .filter((x): x is { s: GoalSnapshot; w: { from: string; to: string } } => x.w !== null);
  if (!dated.length)
    return (
      <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[14px] text-muted">
        {g.timeline.empty}
      </p>
    );
  const from =
    dated
      .map((x) => x.w.from)
      .sort()[0]!
      .slice(0, 7) + "-01";
  const end = dated
    .map((x) => x.w.to)
    .sort()
    .at(-1)!;
  const total = daysBetween(from, end) + 1;
  const pos = (d: string) => `${Math.max(0, Math.min(100, (daysBetween(from, d) / total) * 100))}%`;
  const months: string[] = [];
  for (let d = from; d <= end;) {
    months.push(d);
    const [y, m] = d.split("-").map(Number) as [number, number];
    d = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  }
  const title = new Map(
    visions.map((v) => [v.vision.id, `${v.vision.icon ?? ""} ${v.vision.title}`.trim()]),
  );
  const groups = new Map<string, typeof dated>();
  for (const x of dated) {
    const key = title.get(visionIdsOf(x.s.goal)[0] ?? "") ?? "—";
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }
  const undated = shown.length - dated.length;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
      <div className="overflow-x-auto">
        <div className="relative min-w-[560px]">
          <div className="relative mb-2 ml-[34%] h-5 text-[11px] text-faint">
            {months.map((m) => (
              <span key={m} className="absolute -translate-x-0" style={{ left: pos(m) }}>
                {
                  periodLabel({ from: m, to: m.slice(0, 8) + "28" }, locale)
                    .split(" – ")[0]!
                    .split(" ")[0]
                }
              </span>
            ))}
          </div>
          {[...groups.entries()].map(([group, items]) => (
            <div key={group} className="mb-3">
              <p className="mb-1 truncate text-[12px] font-medium text-muted">{group}</p>
              {items.map(({ s, w }) => {
                const card = goalCard(s, new Map());
                return (
                  <button
                    key={s.goal.id}
                    type="button"
                    onClick={() => onOpen(s.goal.id)}
                    className="grid w-full grid-cols-[34%_minmax(0,1fr)] items-center gap-0 rounded-lg py-1 text-left hover:bg-active"
                  >
                    <span className="truncate pr-3 text-[13px]">
                      {s.goal.icon ? `${s.goal.icon} ` : ""}
                      {s.goal.title}
                    </span>
                    <span className="relative h-5">
                      <span
                        className="absolute top-1 h-3 overflow-hidden rounded-full bg-surface-2"
                        style={{
                          left: pos(w.from),
                          width: `calc(${pos(w.to)} - ${pos(w.from)} + 4px)`,
                        }}
                        title={`${fmt.day(w.from)} – ${fmt.day(w.to)}`}
                      >
                        <span
                          className={cn(
                            "block h-full",
                            card.health === "at_risk"
                              ? "bg-approval"
                              : card.status === "completed"
                                ? "bg-success"
                                : "bg-accent",
                          )}
                          style={{ width: `${card.percent ?? 0}%` }}
                        />
                      </span>
                      {s.goal.targetDate && s.goal.targetDate !== s.goal.periodEnd && (
                        <span
                          aria-hidden
                          className="absolute top-0.5 size-4 -translate-x-1/2 rotate-45 rounded-[3px] border-2 border-fg/60 bg-bg"
                          style={{ left: pos(s.goal.targetDate) }}
                        />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {today >= from && today <= end && (
            <span
              aria-label={g.timeline.today}
              className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent/70"
              style={{ left: `calc(34% + (66% * ${daysBetween(from, today) / total}))` }}
            />
          )}
        </div>
      </div>
      {undated > 0 && <p className="text-[12px] text-faint">{g.timeline.undated(undated)}</p>}
    </div>
  );
}

// ── Workspace ────────────────────────────────────────────────────────────────

export function GoalsView({ data, workspaceId }: { data: GoalsWorkspace; workspaceId: string }) {
  const { t, locale } = useI18n();
  const g = t.native.goals;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  useRealtimeRefresh(workspaceId, [
    "goals",
    "goal_links",
    "visions",
    "goal_progress_events",
    "habit_entries",
    "tasks",
  ]);

  const [status, setStatus] = useState<GoalStatusFilter>(data.archived ? "archived" : "active");
  const [period, setPeriod] = useState<PeriodFilter>("all");
  const [custom, setCustom] = useState({ from: data.today, to: data.today });
  const [query, setQuery] = useState("");
  const [visionId, setVisionId] = useState("");
  const [area, setArea] = useState("");
  const [habitId, setHabitId] = useState("");
  const [sort, setSort] = useState<GoalSort>("attention");
  const [view, setView] = useState<"list" | "timeline">("list");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<{ kind: "goal" | "vision"; id: string } | null>(() => {
    const goal = params.get("goal");
    const vision = params.get("vision");
    return goal ? { kind: "goal", id: goal } : vision ? { kind: "vision", id: vision } : null;
  });
  const [goalDialog, setGoalDialog] = useState<{
    goal: Goal | null;
    initial?: { title?: string; visionId?: string };
  } | null>(null);
  const [visionDialog, setVisionDialog] = useState<{ vision: Vision | null } | null>(null);
  const [editor, setEditor] = useState<{ snapshot: GoalSnapshot; rect: DOMRect } | null>(null);
  const [importing, setImporting] = useState(false);

  // "n" opens a new goal (when not typing), like other ELISE workspaces' quick add.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (
        e.key !== "n" ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        /input|textarea|select/i.test(el.tagName) ||
        el.isContentEditable
      )
        return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setGoalDialog({ goal: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visionList = data.visions.map((v) => v.vision);
  const visionTitles = useMemo(() => new Map(visionList.map((v) => [v.id, v.title])), [visionList]);
  // Period filters match by overlap with each goal's dates (ADR-057).
  const periodMatch = { filter: period, today: data.today, custom };
  const shown = useMemo(
    () =>
      sortGoals(
        filterGoals(
          data.goals,
          {
            status,
            period: periodMatch,
            visionId: visionId || null,
            area: area || null,
            habitId: habitId || null,
            query,
          },
          visionList,
        ),
        sort,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- range derives from period/custom
    [data.goals, status, period, custom, visionId, area, habitId, query, sort, visionList],
  );
  const scoped = useMemo(
    () =>
      filterGoals(
        data.goals,
        {
          period: periodMatch,
          visionId: visionId || null,
          area: area || null,
          habitId: habitId || null,
          query,
        },
        visionList,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- range derives from period/custom
    [data.goals, period, custom, visionId, area, habitId, query, visionList],
  );
  const summary = goalsSummary(scoped);
  const counts = Object.fromEntries(
    TABS.map((s) => [s, filterGoals(scoped, { status: s }).length]),
  ) as Record<GoalStatusFilter, number>;

  const options: GoalOptions = {
    visions: visionList.filter((v) => v.status !== "archived"),
    habits: data.habits,
    goals: data.goals
      .filter((s) => !s.goal.archived)
      .map((s) => ({ id: s.goal.id, title: s.goal.title, icon: s.goal.icon ?? null })),
    areas: data.areas,
  };
  const selectedGoal =
    selected?.kind === "goal" ? data.goals.find((s) => s.goal.id === selected.id) : undefined;
  const selectedVision =
    selected?.kind === "vision" ? visionList.find((v) => v.id === selected.id) : undefined;
  const open = (next: typeof selected) => {
    setSelected(next);
    const q = new URLSearchParams(window.location.search);
    q.delete("goal");
    q.delete("vision");
    if (next) q.set(next.kind, next.id);
    router.replace(`${pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
  };
  const switchArchived = (archived: boolean) => {
    const q = new URLSearchParams(window.location.search);
    if (archived) q.set("archived", "1");
    else q.delete("archived");
    router.replace(`${pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
  };
  const activeFilters = [
    visionId && {
      key: "vision",
      label: visionTitles.get(visionId) ?? "",
      clear: () => setVisionId(""),
    },
    area && { key: "area", label: area, clear: () => setArea("") },
    habitId && {
      key: "habit",
      label: data.habits.find((h) => h.id === habitId)?.name ?? "",
      clear: () => setHabitId(""),
    },
  ].filter(Boolean) as { key: string; label: string; clear: () => void }[];

  const empty = data.goals.length === 0 && data.visions.length === 0 && !data.archived;
  const periodOption = (p: PeriodFilter) => {
    const r = p === "custom" ? null : periodFilterRange(p, data.today);
    return r ? `${g.periodFilters[p]} · ${periodLabel(r, locale)}` : g.periodFilters[p];
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {data.archived ? (
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-medium">{g.tabs.archived}</h2>
            <Button size="sm" variant="ghost" onClick={() => switchArchived(false)}>
              <X />
              {g.tabs.active}
            </Button>
          </div>
        ) : (
          <div
            role="radiogroup"
            aria-label={g.title}
            className="flex max-w-full overflow-x-auto rounded-full bg-surface-2 p-0.5"
          >
            {TABS.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={status === s}
                onClick={() => setStatus(s)}
                className={cn(
                  "h-8 shrink-0 rounded-full px-3 text-[13px] whitespace-nowrap transition-colors",
                  status === s ? "bg-bg font-medium text-fg shadow-sm" : "text-muted hover:text-fg",
                )}
              >
                {g.tabs[s]}
                <span
                  className={cn(
                    "ml-1.5 font-mono text-[11.5px]",
                    s === "at_risk" && counts[s] > 0 ? "text-approval-text" : "text-faint",
                  )}
                >
                  {counts[s]}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
              aria-hidden
            />
            <Input
              aria-label={g.search}
              placeholder={g.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 w-44 pl-9 sm:w-52"
            />
          </div>
          <Menu
            label={g.more}
            items={[
              { label: g.importCsv, onClick: () => setImporting(true) },
              {
                label: data.archived ? g.tabs.active : g.tabs.archived,
                onClick: () => switchArchived(!data.archived),
              },
            ]}
          />
          <Button onClick={() => setGoalDialog({ goal: null })} aria-keyshortcuts="n">
            <Plus />
            {g.new}
          </Button>
          {/* Creating a Vision is a core action: visible, next to New goal, never louder. */}
          <Button variant="secondary" onClick={() => setVisionDialog({ vision: null })}>
            <VisionIcon />
            {g.newVision}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label={g.periodLabel}
          value={period}
          className="h-9 w-auto"
          onChange={(e) => setPeriod(e.target.value as PeriodFilter)}
        >
          {PERIOD_FILTERS.map((p) => (
            <option key={p} value={p}>
              {periodOption(p)}
            </option>
          ))}
        </Select>
        {period === "custom" && (
          <>
            <Input
              type="date"
              aria-label={g.form.from}
              value={custom.from}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
              className="h-9 w-auto"
            />
            <Input
              type="date"
              aria-label={g.form.to}
              value={custom.to}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
              className="h-9 w-auto"
            />
          </>
        )}
        <div className="relative">
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <SlidersHorizontal />
            {g.filters}
            {activeFilters.length > 0 && (
              <span className="font-mono text-[11.5px]">{activeFilters.length}</span>
            )}
            <ChevronDown />
          </Button>
          {filtersOpen && (
            <div className="absolute top-full left-0 z-40 mt-1.5 flex w-72 flex-col gap-2.5 rounded-2xl border border-border-strong bg-[var(--overlay-bg)] p-3 shadow-[var(--menu-shadow)]">
              <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                {g.filterVision}
                <Select
                  value={visionId}
                  onChange={(e) => setVisionId(e.target.value)}
                  className="h-9"
                >
                  <option value="">{g.any}</option>
                  {visionList.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title.slice(0, 60)}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                {g.filterArea}
                <Select value={area} onChange={(e) => setArea(e.target.value)} className="h-9">
                  <option value="">{g.any}</option>
                  {data.areas.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                {g.filterHabit}
                <Select
                  value={habitId}
                  onChange={(e) => setHabitId(e.target.value)}
                  className="h-9"
                >
                  <option value="">{g.any}</option>
                  {data.habits.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.icon ? `${h.icon} ` : ""}
                      {h.name}
                    </option>
                  ))}
                </Select>
              </label>
              <Button
                size="sm"
                variant="ghost"
                className="self-end"
                onClick={() => setFiltersOpen(false)}
              >
                {t.common.close}
              </Button>
            </div>
          )}
        </div>
        {activeFilters.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={f.clear}
            aria-label={`${g.clearFilters}: ${f.label}`}
            className="inline-flex h-8 max-w-56 items-center gap-1.5 rounded-full bg-accent-soft px-3 text-[12.5px] text-accent-text"
          >
            <span className="truncate">{f.label}</span>
            <X className="size-3.5 shrink-0" aria-hidden />
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Select
            aria-label={g.sort}
            value={sort}
            className="h-9 w-auto"
            onChange={(e) => setSort(e.target.value as GoalSort)}
          >
            {GOAL_SORTS.map((s) => (
              <option key={s} value={s}>
                {g.sort}: {g.sorts[s]}
              </option>
            ))}
          </Select>
          <div
            role="radiogroup"
            aria-label={g.views.list}
            className="flex rounded-full bg-surface-2 p-0.5"
          >
            {(["list", "timeline"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                onClick={() => setView(v)}
                className={cn(
                  "h-8 rounded-full px-3 text-[13px]",
                  view === v ? "bg-bg font-medium shadow-sm" : "text-muted hover:text-fg",
                )}
              >
                {g.views[v]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {importing && <ImportPanel kind="goals" onDone={() => setImporting(false)} />}

      {empty ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-14 text-center">
          <span className="text-[28px]" aria-hidden>
            🎯
          </span>
          <h2 className="font-medium">{g.empty.title}</h2>
          <p className="max-w-md text-[13.5px] text-muted">{g.empty.body}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setGoalDialog({ goal: null })}>
              <Plus />
              {g.empty.createGoal}
            </Button>
            <Button variant="secondary" onClick={() => setVisionDialog({ vision: null })}>
              <Plus />
              {g.empty.createVision}
            </Button>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {g.empty.examples.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setGoalDialog({ goal: null, initial: { title: ex } })}
                className="rounded-full bg-surface-2 px-3 py-1 text-[13px] text-muted hover:text-fg"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Summary */}
          {!data.archived && (
            <dl className="flex flex-wrap items-stretch divide-x divide-border rounded-2xl border border-border bg-surface text-[13px]">
              {(
                [
                  [g.summary.active, summary.active, false],
                  [g.summary.atRisk, summary.atRisk, summary.atRisk > 0],
                  [g.summary.completed, summary.completed, false],
                  [
                    g.summary.average,
                    summary.averageProgress === null ? "—" : `${summary.averageProgress}%`,
                    false,
                  ],
                ] as const
              ).map(([label, value, flag]) => (
                <div key={label} className="flex flex-col gap-0.5 px-4 py-2.5">
                  <dt className="text-muted">{label}</dt>
                  <dd className={cn("font-mono text-[18px]", flag && "text-approval-text")}>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {/* Visions */}
          {!data.archived && (
            <section aria-label={g.visions} className="flex flex-col gap-2">
              <h2 className="type-label text-faint">{g.visions}</h2>
              <div className="-mx-1 flex gap-2.5 overflow-x-auto px-1 pb-1 lg:grid lg:grid-cols-3 lg:overflow-visible 2xl:grid-cols-4">
                {data.visions
                  .filter((v) => v.vision.status !== "archived")
                  .map((v) => (
                    <VisionCard
                      key={v.vision.id}
                      summary={v}
                      selected={selected?.kind === "vision" && selected.id === v.vision.id}
                      onOpen={() =>
                        open(
                          selected?.id === v.vision.id ? null : { kind: "vision", id: v.vision.id },
                        )
                      }
                    />
                  ))}
                <button
                  type="button"
                  onClick={() => setVisionDialog({ vision: null })}
                  className="flex min-w-[11rem] items-center justify-center gap-2 rounded-2xl border border-dashed border-border px-4 py-3.5 text-[13px] text-muted hover:border-accent-line hover:text-fg"
                >
                  <Plus className="size-4" aria-hidden />
                  {g.newVision}
                </button>
              </div>
            </section>
          )}

          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <section aria-label={g.goalsHeading} className="flex min-w-0 flex-col gap-2">
              {view === "timeline" ? (
                <Timeline
                  shown={shown}
                  visions={data.visions}
                  today={data.today}
                  onOpen={(id) => open({ kind: "goal", id })}
                />
              ) : shown.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[14px] text-muted">
                  {data.goals.length ? g.noMatch : g.none}
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
                  {shown.map((s) => {
                    const card = goalCard(s, visionTitles);
                    const isSelected = selected?.kind === "goal" && selected.id === s.goal.id;
                    const editable =
                      s.goal.status === "active" &&
                      !s.goal.archived &&
                      s.goal.progressType !== "binary";
                    return (
                      <li
                        key={s.goal.id}
                        className={cn(
                          "relative rounded-2xl border bg-surface px-4 py-3.5 transition-colors hover:border-accent-line",
                          isSelected ? "border-accent-line" : "border-border",
                          s.goal.status !== "active" && "opacity-80",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => open(isSelected ? null : { kind: "goal", id: s.goal.id })}
                          className="absolute inset-0 rounded-2xl focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                          aria-label={s.goal.title}
                        />
                        <div className="pointer-events-none relative [&_button]:pointer-events-auto">
                          <GoalSummary
                            card={card}
                            onValueClick={
                              editable
                                ? (el) =>
                                    setEditor({ snapshot: s, rect: el.getBoundingClientRect() })
                                : undefined
                            }
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <aside className="flex min-w-0 flex-col gap-3">
              {selectedGoal ? (
                <GoalDetailPanel
                  key={selectedGoal.goal.id}
                  snapshot={selectedGoal}
                  visionTitles={visionTitles}
                  version={data.goals}
                  onClose={() => open(null)}
                  onEdit={() => setGoalDialog({ goal: selectedGoal.goal })}
                  onProgress={(el) =>
                    setEditor({ snapshot: selectedGoal, rect: el.getBoundingClientRect() })
                  }
                  onOpenGoal={(id) => open({ kind: "goal", id })}
                />
              ) : selectedVision ? (
                <VisionDetailPanel
                  key={selectedVision.id}
                  vision={selectedVision}
                  goals={data.goals}
                  onClose={() => open(null)}
                  onEdit={() => setVisionDialog({ vision: selectedVision })}
                  onNewGoal={() =>
                    setGoalDialog({ goal: null, initial: { visionId: selectedVision.id } })
                  }
                  onOpenGoal={(id) => open({ kind: "goal", id })}
                />
              ) : (
                <Analytics shown={scoped} visions={data.visions} />
              )}
            </aside>
          </div>
        </>
      )}

      <GoalDialog
        open={goalDialog !== null}
        onClose={() => setGoalDialog(null)}
        goal={goalDialog?.goal}
        initial={goalDialog?.initial}
        today={data.today}
        options={options}
      />
      <VisionDialog
        open={visionDialog !== null}
        onClose={() => setVisionDialog(null)}
        vision={visionDialog?.vision}
        areas={data.areas}
      />
      {editor && (
        <ProgressEditor
          goal={editor.snapshot.goal}
          linkedValue={editor.snapshot.progress.linkedValue}
          anchor={editor.rect}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}
