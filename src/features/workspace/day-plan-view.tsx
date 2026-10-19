"use client";

import { Check, TriangleAlert } from "lucide-react";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Plan = SurfacePayloads["day_plan"];
type Block = Plan["blocks"][number];

/** "martes 20 de octubre": the plan's own date, never "today" guessed by the device. */
export function useDayLabel(date: string) {
  const { locale } = useI18n();
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}

/**
 * A day's plan (ADR-098): the blocks in time order with their real boundaries, the free
 * stretches between them, and what's proposed vs. already in the calendar. Proposed blocks are
 * outlined (a draft); saved ones are solid. Read top to bottom by a screen reader as a list.
 */
export function DayPlanBody({ p, focus = false }: { p: Plan; focus?: boolean }) {
  const { t } = useI18n();
  const s = t.workspace.dayPlan;
  const day = useDayLabel(p.date);
  const proposed = p.blocks.some((b) => b.state === "proposed");
  const rows = [
    ...p.blocks.map((b) => ({ at: b.start, block: b, gap: null })),
    ...p.gaps.map((g) => ({ at: g.start, block: null, gap: g })),
  ].sort((a, b) => a.at.localeCompare(b.at) || (a.block ? -1 : 1));
  const overlaps = p.warnings.filter((w) => w.kind === "overlap").length;
  const label = (id: string) => p.blocks.find((b) => b.id === id)?.label ?? id;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[15px] font-medium tracking-[-0.01em] first-letter:uppercase md:text-base">
          {day}
        </p>
        <p className={cn("text-[12px]", proposed ? "text-approval-text" : "text-accent-text")}>
          {proposed ? s.draft : s.allSaved}
          {p.version > 1 && <span className="text-faint"> · {s.version(p.version)}</span>}
        </p>
      </div>
      {(p.warnings.some((w) => w.kind !== "overlap") || overlaps > 0) && (
        <ul role="status" className="flex flex-col gap-1 text-[12.5px] text-approval-text">
          {overlaps > 0 && (
            <li className="flex items-center gap-1.5">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              {s.warnings.overlaps(overlaps)}
            </li>
          )}
          {p.warnings.map((w, i) =>
            w.kind === "overlap" ? null : (
              <li key={i} className="flex items-center gap-1.5">
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                {w.kind === "calendar_unavailable"
                  ? s.warnings.calendarUnavailable
                  : s.warnings.nonexistent(w.at)}
              </li>
            ),
          )}
        </ul>
      )}
      <ol
        aria-label={day}
        className={cn(
          "-mx-1 flex flex-col",
          // A long day scrolls inside the card; Focus shows it whole.
          !focus && "max-h-[30rem] overflow-y-auto overscroll-contain",
        )}
      >
        {rows.map((r) =>
          r.block ? (
            <BlockRow key={r.block.id} b={r.block} conflictWith={r.block.conflicts.map(label)} />
          ) : (
            <li
              key={`gap-${r.gap!.start}`}
              className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 px-1 py-1 text-[12px] text-faint"
            >
              <span className="font-mono">{r.gap!.start}</span>
              <span>{s.free(s.duration(r.gap!.minutes))}</span>
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

function BlockRow({ b, conflictWith }: { b: Block; conflictWith: string[] }) {
  const { t } = useI18n();
  const s = t.workspace.dayPlan;
  const saved = b.state === "saved";
  return (
    <li className="grid grid-cols-[104px_minmax(0,1fr)] gap-3 rounded-xl px-1 py-1.5">
      <span className="flex flex-col font-mono leading-tight">
        <span className="text-[13px] text-fg">
          {b.start}–{b.end}
        </span>
        <span className="text-[11px] text-faint">{s.duration(b.minutes)}</span>
      </span>
      <span
        className={cn(
          "min-w-0 rounded-lg border-l-[3px] py-0.5 pl-2.5",
          saved ? "border-accent" : "border-dashed border-accent-line",
          conflictWith.length > 0 && "border-danger",
        )}
      >
        <span className="block truncate text-[14px] font-medium">{b.label}</span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
          <span>{s.categories[b.category]}</span>
          <span aria-hidden>·</span>
          <span>{s.origin[b.origin]}</span>
          {saved && b.origin !== "calendar" && (
            <span className="inline-flex items-center gap-0.5 text-accent-text">
              <Check className="size-3" aria-hidden />
              {s.saved}
            </span>
          )}
          {conflictWith.length > 0 && (
            <span className="text-danger-text">
              · {s.conflict}: {conflictWith.join(", ")}
            </span>
          )}
        </span>
        {b.notes && <span className="mt-0.5 block text-[12.5px] text-faint">{b.notes}</span>}
      </span>
    </li>
  );
}
