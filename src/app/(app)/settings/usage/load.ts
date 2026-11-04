import { accountUsage } from "@/application/account-usage-service";
import { budgetNotice } from "@/application/budget-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => ({
  usage: await accountUsage(auth),
  notice: await budgetNotice(auth).catch(() => null),
})) satisfies RouteLoader<unknown>;

export type UsageProps = Awaited<ReturnType<typeof load>>;
