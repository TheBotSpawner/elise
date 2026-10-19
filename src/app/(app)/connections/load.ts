import { configuredProviders, listConnections } from "@/application/connections-service";
import { moduleVisibility } from "@/application/modules-service";

import type { RouteLoader } from "../route-contract";

export const load = (async (auth) => {
  const [list, modules] = await Promise.all([listConnections(auth), moduleVisibility(auth)]);
  return { accounts: list.connections, configured: configuredProviders(list), modules };
}) satisfies RouteLoader<unknown>;

export type ConnectionsProps = Awaited<ReturnType<typeof load>>;
