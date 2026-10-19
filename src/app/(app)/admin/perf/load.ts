import { notFound } from "next/navigation";

import { recentLivePerf, recentTurnPerf } from "@/application/perf-service";
import { isAdmin } from "@/application/usage-service";
import { isEnabled } from "@/config/flags";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => {
  if (!isEnabled("usagePage") || !isAdmin(auth)) notFound();
  const [{ turns, groups }, live] = await Promise.all([recentTurnPerf(auth), recentLivePerf(auth)]);
  return { turns, groups, live, timezone: auth.profile.timezone };
}) satisfies RouteLoader<unknown>;

export type PerfProps = Awaited<ReturnType<typeof load>>;
