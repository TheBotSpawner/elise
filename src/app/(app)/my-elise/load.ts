import { visibleModules } from "@/application/modules-service";

import type { RouteLoader } from "../route-contract";

export const load = (async (auth) => ({
  modules: await visibleModules(auth),
})) satisfies RouteLoader<unknown>;

export type MyEliseProps = Awaited<ReturnType<typeof load>>;
