import { financeSourcesOverview } from "@/application/finance-service";

import type { RouteLoader } from "../../../route-contract";

export const load = (async (auth) => ({
  overview: await financeSourcesOverview(auth),
  workspaceId: auth.workspaceId,
})) satisfies RouteLoader<unknown>;

export type FinanceSourcesProps = Awaited<ReturnType<typeof load>>;
