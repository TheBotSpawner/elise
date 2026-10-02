import { AbortTaskRunError, schedules, task } from "@trigger.dev/sdk";
import { z } from "zod";

import { dispatchDueSchedules, executeScheduleRun } from "@/application/background";
import { MAX_ATTEMPTS } from "@/core/schedules/runner";
import { withUsageScope } from "@/infrastructure/observability/usage";

/**
 * Thin Trigger.dev entry points (docs/architecture/14 §3). All business logic lives in ELISE
 * application services; these only validate the payload and hand over.
 */

const scheduleRunPayload = z.object({
  workspaceId: z.uuid(),
  scheduleRunId: z.uuid(),
});

export const scheduleRunTask = task({
  id: "schedule-run",
  maxDuration: 300,
  retry: {
    maxAttempts: MAX_ATTEMPTS,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  run: async (payload: z.infer<typeof scheduleRunPayload>, { ctx }) => {
    const parsed = scheduleRunPayload.safeParse(payload);
    if (!parsed.success) throw new AbortTaskRunError("Invalid schedule run payload");
    // Throws only for transient errors; the runtime retries those with backoff.
    const scope = { workspaceId: parsed.data.workspaceId, feature: "schedule" };
    const status = await withUsageScope(scope, () =>
      executeScheduleRun({ ...parsed.data, attempt: ctx.attempt.number }),
    );
    return { status };
  },
});

/** Every minute: claim due occurrences (each exactly once) and start their runs. */
export const scheduleDispatchTask = schedules.task({
  id: "schedules-dispatch",
  cron: "* * * * *",
  maxDuration: 120,
  run: async () => dispatchDueSchedules(),
});
