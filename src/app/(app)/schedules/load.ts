import { listConnections } from "@/application/connections-service";
import { spaceOptions } from "@/application/knowledge-service";
import { marketsConfigured } from "@/application/markets-service";
import { methodStore } from "@/application/methods-service";
import { listSchedules } from "@/application/schedules-service";
import { scheduleInputSchema, type ScheduleInput } from "@/core/schedules/schedule";

import type { RouteLoader } from "../route-contract";

/** A proposal from chat opened for editing arrives as base64url JSON and is re-validated here. */
function parseDraft(value: string | string[] | undefined): ScheduleInput | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = scheduleInputSchema.safeParse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const load = (async (auth, { search }) => {
  const [{ schedules, backgroundAvailable }, spaces, methods, connections] = await Promise.all([
    listSchedules(auth),
    spaceOptions(auth).catch(() => []),
    methodStore(auth)
      .index()
      .catch(() => []),
    listConnections(auth).catch(() => null),
  ]);
  // Slack workspaces a brief can read (ADR-062); none connected → the Slack block isn't offered.
  const slackWorkspaces = (connections?.connections ?? [])
    .filter((c) => c.providerKey === "slack" && c.capabilities.some((x) => x.enabled))
    .map((c) => ({ id: c.id, name: c.displayName }));
  return {
    schedules,
    workspaceId: auth.workspaceId,
    timezone: auth.profile.timezone,
    spaces,
    slackWorkspaces,
    marketsAvailable: marketsConfigured(),
    methods: methods.map((m) => ({ id: m.id, name: m.name })),
    backgroundAvailable,
    draft: parseDraft(search.draft),
  };
}) satisfies RouteLoader<unknown>;

export type SchedulesProps = Awaited<ReturnType<typeof load>>;
