import { contextOptions } from "@/application/contexts-service";
import { shortcutStore } from "@/application/shortcuts-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => {
  const [shortcuts, contexts] = await Promise.all([
    shortcutStore(auth).list(),
    contextOptions(auth),
  ]);
  return { shortcuts, contexts: contexts.map((c) => ({ id: c.id, name: c.name })) };
}) satisfies RouteLoader<unknown>;

export type ShortcutsProps = Awaited<ReturnType<typeof load>>;
