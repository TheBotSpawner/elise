import type { Metadata } from "next";

import { requireAuthContext } from "@/application/auth-context";
import { listTasks } from "@/application/tasks-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { TaskBoard } from "@/features/tasks/task-board";
import { getT } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const tasks = await listTasks(auth, "all");
  return (
    <PageContainer>
      <PageHeader title={t.tasks.title} subtitle={t.tasks.subtitle} />
      <TaskBoard tasks={tasks} workspaceId={auth.workspaceId} timezone={auth.profile.timezone} />
    </PageContainer>
  );
}
