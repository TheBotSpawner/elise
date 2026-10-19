import { accountUsage } from "@/application/account-usage-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => ({
  usage: await accountUsage(auth),
})) satisfies RouteLoader<unknown>;

export type UsageProps = Awaited<ReturnType<typeof load>>;
