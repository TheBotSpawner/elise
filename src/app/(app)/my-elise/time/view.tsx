"use client";

import { useState } from "react";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { AlarmsPanel } from "@/features/time/alarms-view";
import { TimeSettings } from "@/features/time/time-settings";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/** My Elise → Tiempos (ADR-045, ADR-100): alarms, and the timers and stopwatches. */
export function View() {
  const { t } = useI18n();
  const tabs = t.time.alarms.tabs;
  const [tab, setTab] = useState<"alarms" | "timers">("alarms");
  return (
    <PageContainer>
      <PageHeader
        title={t.time.settings.title}
        icon={MY_ELISE_ICONS.time}
        info={[t.time.settings.subtitle]}
      />
      <div role="tablist" className="mb-6 flex gap-2">
        {(
          [
            ["alarms", tabs.alarms],
            ["timers", `${tabs.timers} · ${tabs.stopwatches}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-full border px-4 py-1.5 text-[13.5px]",
              tab === id
                ? "border-accent-line bg-accent-soft text-accent-text"
                : "border-border text-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "alarms" ? <AlarmsPanel /> : <TimeSettings />}
    </PageContainer>
  );
}
