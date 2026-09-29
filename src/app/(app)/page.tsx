import { listPendingApprovals } from "@/application/approvals-service";
import { requireAuthContext } from "@/application/auth-context";
import { listSpaces } from "@/application/knowledge-service";
import { latestBrief } from "@/application/schedules-service";
import { listTasks } from "@/application/tasks-service";
import { todayIn } from "@/core/time";
import { ChatSurface } from "@/features/chat/chat-surface";

/** Home is chat-first: the Orb, one input, and only real, quiet context. */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const [auth, params] = await Promise.all([requireAuthContext(), searchParams]);
  const spaceId = typeof params.space === "string" ? params.space : null;
  const [tasks, approvals, brief] = await Promise.all([
    listTasks(auth, "open").catch(() => []) /* ambient context never blocks Home */,
    listPendingApprovals(auth),
    latestBrief(auth).catch(() => null),
  ]);
  // Only a Space of this workspace can scope the conversation.
  const space = spaceId
    ? ((await listSpaces(auth).catch(() => [])).find((s) => s.id === spaceId) ?? null)
    : null;
  const today = todayIn(auth.profile.timezone);

  return (
    <ChatSurface
      timezone={auth.profile.timezone}
      userName={auth.profile.displayName ?? ""}
      space={space ? { id: space.id, path: space.path } : null}
      ambient={{
        dueToday: tasks.filter((task) => task.dueDate === today).length,
        overdue: tasks.filter((task) => task.dueDate !== null && task.dueDate < today).length,
        pendingApprovals: approvals.length,
        brief,
      }}
    />
  );
}
