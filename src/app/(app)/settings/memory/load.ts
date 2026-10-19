import { getMemory } from "@/application/memory-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => {
  const memory = await getMemory(auth);
  return { enabled: memory.enabled, facts: memory.facts };
}) satisfies RouteLoader<unknown>;

export type MemoryProps = Awaited<ReturnType<typeof load>>;
