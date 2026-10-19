import { habitsWorkspace, parseHabitParams } from "@/application/native-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth, { search }) => ({
  // ?view=week|month|year|custom&date=…&from=…&to=…&status=… (ADR-053); only that range is read.
  data: await habitsWorkspace(auth, parseHabitParams(search)),
  workspaceId: auth.workspaceId,
})) satisfies RouteLoader<unknown>;

export type HabitsProps = Awaited<ReturnType<typeof load>>;
