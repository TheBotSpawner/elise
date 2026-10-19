import { tasksOverview } from "@/application/tasks-service";
import { parseSelection } from "@/features/tasks/views";

import { one, type RouteLoader } from "../../route-contract";

export const load = (async (auth, { search }) => {
  // Older links (Home's "N vencidas" → ?view=overdue, ?view=open) keep working.
  const view = one(search.view) === "open" ? "all" : one(search.view);
  const selection = parseSelection({ view, list: one(search.list), label: one(search.label) });
  // Every enabled account is read live on open (ADR-046); completed history only when asked for.
  const overview = await tasksOverview(auth, {
    includeCompleted: selection.kind === "view" && selection.view === "completed",
  });
  return { overview, selection, workspaceId: auth.workspaceId, timezone: auth.profile.timezone };
}) satisfies RouteLoader<unknown>;

export type TasksProps = Awaited<ReturnType<typeof load>>;
