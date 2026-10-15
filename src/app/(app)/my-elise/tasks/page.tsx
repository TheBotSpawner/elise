import type { Metadata } from "next";

import { requireAuthContext } from "@/application/auth-context";
import { tasksOverview } from "@/application/tasks-service";
import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageHeader } from "@/components/shared/page";
import { TaskWorkspace } from "@/features/tasks/task-workspace";
import { parseSelection } from "@/features/tasks/views";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Tasks" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function TasksPage({ searchParams }: PageProps<"/my-elise/tasks">) {
  const [auth, { t }, params] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  // Older links (Home's "N vencidas" → ?view=overdue, ?view=open) keep working.
  const view = one(params.view) === "open" ? "all" : one(params.view);
  const selection = parseSelection({ view, list: one(params.list), label: one(params.label) });
  // Every enabled account is read live on open (ADR-046); completed history only when asked for.
  const overview = await tasksOverview(auth, {
    includeCompleted: selection.kind === "view" && selection.view === "completed",
  });
  return (
    // Wide: Tasks uses the screen for navigation, the list and details (ADR-050).
    <div className="mx-auto w-full max-w-[1560px] px-4 pt-6 pb-16 md:px-10 md:pt-10">
      <PageHeader title={t.tasks.title} icon={MY_ELISE_ICONS.tasks} info={[t.tasks.subtitle]} />
      <TaskWorkspace
        overview={overview}
        selection={selection}
        workspaceId={auth.workspaceId}
        timezone={auth.profile.timezone}
      />
    </div>
  );
}
