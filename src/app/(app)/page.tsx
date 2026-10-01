import { listPendingApprovals } from "@/application/approvals-service";
import { requireAuthContext } from "@/application/auth-context";
import { contextOptions } from "@/application/contexts-service";
import { loadVoiceSession } from "@/application/interaction-thread";
import { listSpaces } from "@/application/knowledge-service";
import { latestBrief } from "@/application/schedules-service";
import { openTasks } from "@/application/tasks-service";
import { activeWorkspace, loadWorkspace } from "@/application/workspace-service";
import { ChatSurface } from "@/features/chat/chat-surface";

/** Home is chat-first: the Orb, one input, and only real, quiet context. */
export default async function HomePage({ searchParams }: PageProps<"/">) {
  const [auth, params] = await Promise.all([requireAuthContext(), searchParams]);
  const spaceId = typeof params.space === "string" ? params.space : null;
  // A voice session reopens here (it has no History thread of its own).
  const sessionId =
    typeof params.session === "string" && /^[0-9a-f-]{36}$/i.test(params.session)
      ? params.session
      : null;
  const voiceSession = sessionId
    ? await Promise.all([
        loadVoiceSession(auth, sessionId),
        loadWorkspace(auth, { kind: "session", id: sessionId }).catch(() => undefined),
      ])
    : null;
  const restored = voiceSession?.[0]
    ? { messages: voiceSession[0], workspace: voiceSession[1] }
    : null;
  const [tasks, approvals, brief, resume, contexts] = await Promise.all([
    // Same service and definitions as the Tasks screen, so the counts match what it lists.
    openTasks(auth).catch(() => null) /* ambient context never blocks Home */,
    listPendingApprovals(auth),
    latestBrief(auth).catch(() => null),
    activeWorkspace(auth).catch(() => null),
    contextOptions(auth),
  ]);
  // Only a Space of this workspace can scope the conversation.
  const space = spaceId
    ? ((await listSpaces(auth).catch(() => [])).find((s) => s.id === spaceId) ?? null)
    : null;

  return (
    <ChatSurface
      key={restored ? sessionId : "home"}
      {...(restored
        ? {
            thread: { kind: "session" as const, id: sessionId! },
            initialMessages: restored.messages,
            initialWorkspace: restored.workspace,
          }
        : {})}
      voice={auth.profile.voice}
      timezone={auth.profile.timezone}
      workspaceId={auth.workspaceId}
      userName={auth.profile.displayName ?? ""}
      contexts={contexts}
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
