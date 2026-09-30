import type { Metadata } from "next";

import { requireAuthContext } from "@/application/auth-context";
import { tasksOverview } from "@/application/tasks-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import type { TaskView } from "@/core/capabilities/tasks";
import { TaskBoard } from "@/features/tasks/task-board";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Tasks" };

const VIEWS: TaskView[] = ["open", "today", "overdue", "completed"];

export default async function TasksPage({ searchParams }: PageProps<"/my-elise/tasks">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  const requested = typeof params.view === "string" ? params.view : "open";
  const view = (VIEWS as string[]).includes(requested) ? (requested as TaskView) : "open";
  const source = typeof params.source === "string" ? params.source : null;
  // Completed tasks load only when asked for: actionable work comes first.
  const overview = await tasksOverview(auth, { includeCompleted: view === "completed" });
  return (
    <PageContainer>
      <PageHeader title={t.tasks.title} subtitle={t.tasks.subtitle} />
      <TaskBoard
        overview={overview}
        view={view}
        source={overview.sources.some((s) => s.connectionId === source) ? source : null}
        workspaceId={auth.workspaceId}
        timezone={auth.profile.timezone}
      />
    </PageContainer>
  );
}
