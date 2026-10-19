import { notFound } from "next/navigation";

import { isAdmin, usageSummary } from "@/application/usage-service";
import { isEnabled } from "@/config/flags";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => {
  if (!isEnabled("usagePage") || !isAdmin(auth)) notFound();
  return { summary: await usageSummary(auth, 30) };
}) satisfies RouteLoader<unknown>;

export type UsageProps = Awaited<ReturnType<typeof load>>;
