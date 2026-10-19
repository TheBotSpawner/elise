import { listContextProfiles } from "@/application/contexts-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => {
  const profiles = await listContextProfiles(auth, true);
  return {
    contexts: profiles
      .filter((p) => !p.section)
      .map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        icon: p.icon,
        accent: p.accent,
        status: p.status,
        description: p.description,
        links: p.links.filter((l) => l.confirmed).length,
      })),
  };
}) satisfies RouteLoader<unknown>;

export type ContextsProps = Awaited<ReturnType<typeof load>>;
