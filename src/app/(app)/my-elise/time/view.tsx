"use client";

import { useState } from "react";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { AlarmsPanel } from "@/features/time/alarms-view";
import { StopwatchPanel, TimersPanel } from "@/features/time/time-settings";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/** My Elise → Tiempos (ADR-045, ADR-100): alarms, and the timers and stopwatches. */
export function View() {
  const { t } = useI18n();
  const tabs = t.time.alarms.tabs;
  const [tab, setTab] = useState<"alarms" | "timers" | "stopwatch">("alarms");
  return (
    <PageContainer>
      <PageHeader
        title={t.time.settings.title}
        icon={MY_ELISE_ICONS.time}
        info={[t.time.settings.subtitle]}
      />
      <div
        role="tablist"
        className="mb-6 flex w-full max-w-md rounded-full border border-border bg-surface-2 p-1"
      >
        {(
          [
            ["alarms", tabs.alarms],
            ["timers", tabs.timers],
            ["stopwatch", tabs.stopwatch],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "flex-1 rounded-full px-4 py-1.5 text-[13.5px] transition-colors",
              tab === id ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "alarms" ? <AlarmsPanel /> : tab === "timers" ? <TimersPanel /> : <StopwatchPanel />}
    </PageContainer>
  );
}
