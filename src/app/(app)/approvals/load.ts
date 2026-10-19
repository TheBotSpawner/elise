import { listPendingApprovals } from "@/application/approvals-service";

import type { RouteLoader } from "../route-contract";

export const load = (async (auth) => ({
  approvals: await listPendingApprovals(auth),
  timezone: auth.profile.timezone,
})) satisfies RouteLoader<unknown>;

export type ApprovalsProps = Awaited<ReturnType<typeof load>>;
