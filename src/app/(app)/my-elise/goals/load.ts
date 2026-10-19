import { goalsWorkspace } from "@/application/native-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth, { search }) => ({
  // ?archived=1 reads the archive instead; ?goal=… / ?vision=… open a detail (ADR-055).
  data: await goalsWorkspace(auth, search.archived === "1"),
  workspaceId: auth.workspaceId,
})) satisfies RouteLoader<unknown>;

export type GoalsProps = Awaited<ReturnType<typeof load>>;
