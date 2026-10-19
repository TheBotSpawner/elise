"use client";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageHeader } from "@/components/shared/page";
import { TaskWorkspace } from "@/features/tasks/task-workspace";
import { useI18n } from "@/lib/i18n/client";

import type { TasksProps } from "./load";

export function View({ overview, selection, workspaceId, timezone }: TasksProps) {
  const { t } = useI18n();
  return (
    // Wide: Tasks uses the screen for navigation, the list and details (ADR-050).
    <div className="mx-auto w-full max-w-[1560px] px-4 pt-6 pb-16 md:px-10 md:pt-10">
      <PageHeader title={t.tasks.title} icon={MY_ELISE_ICONS.tasks} info={[t.tasks.subtitle]} />
      <TaskWorkspace
        overview={overview}
        selection={selection}
        workspaceId={workspaceId}
        timezone={timezone}
      />
    </div>
  );
}
