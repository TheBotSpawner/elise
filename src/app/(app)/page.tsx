import { listPendingApprovals } from "@/application/approvals-service";
import { requireAuthContext } from "@/application/auth-context";
import { listTasks } from "@/application/tasks-service";
import { todayIn } from "@/core/time";
import { ChatSurface } from "@/features/chat/chat-surface";

/** Home is chat-first: the Orb, one input, and only real, quiet context. */
export default async function HomePage() {
  const auth = await requireAuthContext();
  const [tasks, approvals] = await Promise.all([
    listTasks(auth, "open"),
    listPendingApprovals(auth),
  ]);
  const today = todayIn(auth.profile.timezone);

  return (
    <ChatSurface
      timezone={auth.profile.timezone}
      userName={auth.profile.displayName ?? ""}
      ambient={{
        dueToday: tasks.filter((task) => task.dueDate === today).length,
        overdue: tasks.filter((task) => task.dueDate !== null && task.dueDate < today).length,
        pendingApprovals: approvals.length,
      }}
    />
  );
}
