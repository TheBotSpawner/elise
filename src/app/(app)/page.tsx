import { listPendingApprovals } from "@/application/approvals-service";
import { requireAuthContext } from "@/application/auth-context";
import { listSpaces } from "@/application/knowledge-service";
import { latestBrief } from "@/application/schedules-service";
import { openTasks } from "@/application/tasks-service";
import { activeWorkspace } from "@/application/workspace-service";
import { ChatSurface } from "@/features/chat/chat-surface";

/** Home is chat-first: the Orb, one input, and only real, quiet context. */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const [auth, params] = await Promise.all([requireAuthContext(), searchParams]);
  const spaceId = typeof params.space === "string" ? params.space : null;
  const [tasks, approvals, brief, resume] = await Promise.all([
    // Same service and definitions as the Tasks screen, so the counts match what it lists.
    openTasks(auth).catch(() => null) /* ambient context never blocks Home */,
    listPendingApprovals(auth),
    latestBrief(auth).catch(() => null),
    activeWorkspace(auth).catch(() => null),
  ]);
  // Only a Space of this workspace can scope the conversation.
  const space = spaceId
    ? ((await listSpaces(auth).catch(() => [])).find((s) => s.id === spaceId) ?? null)
    : null;

  return (
    <ChatSurface
      timezone={auth.profile.timezone}
      workspaceId={auth.workspaceId}
      userName={auth.profile.displayName ?? ""}
      space={
        space ? { id: space.id, path: space.path, icon: space.icon, color: space.color } : null
      }
      ambient={{
        dueToday: tasks?.counts.dueToday ?? 0,
        overdue: tasks?.counts.overdue ?? 0,
        pendingApprovals: approvals.length,
        brief,
        resume,
      }}
    />
  );
}
