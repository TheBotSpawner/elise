import { AbortTaskRunError, task } from "@trigger.dev/sdk";
import { z } from "zod";

import { ownerContext } from "@/application/background";
import { completeTimerRun } from "@/application/time-service";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";

/**
 * A timer's end (ADR-045), as a delayed run scheduled for `endsAt` with the timer's version as
 * idempotency key. It re-reads the canonical timer and completes it only if nothing changed
 * since: a pause, extra time, a cancel or a restart makes this run stale.
 */

const payload = z.object({
  workspaceId: z.uuid(),
  timerId: z.uuid(),
  version: z.number().int().min(1),
});

export const timeCompleteTask = task({
  id: "time-complete",
  maxDuration: 60,
  // A run that wakes a moment early (clock skew) retries shortly after.
  retry: { maxAttempts: 5, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000 },
  run: async (input: z.infer<typeof payload>) => {
    const parsed = payload.safeParse(input);
    if (!parsed.success) throw new AbortTaskRunError("Invalid timer payload");
    const result = await completeTimerRun(parsed.data, ownerContext, createAdminClient());
    logger.info("time.complete_run", { result });
    if (result === "early") throw new Error("Timer not due yet");
    return { result };
  },
});
