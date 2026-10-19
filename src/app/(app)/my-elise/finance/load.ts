import { financeOverview, parseFinanceFilters } from "@/application/finance-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth, { search }) => ({
  overview: await financeOverview(auth, parseFinanceFilters(search)),
  workspaceId: auth.workspaceId,
})) satisfies RouteLoader<unknown>;

export type FinanceProps = Awaited<ReturnType<typeof load>>;
