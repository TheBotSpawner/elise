import { runs, tasks } from "@trigger.dev/sdk";

import { serverEnv } from "@/config/server-env";
import { AppError } from "@/core/errors";
import type { BackgroundRuntime } from "@/core/schedules/runner";
import type { scheduleRunTask } from "@/trigger/schedules";

export function isBackgroundConfigured(): boolean {
  return Boolean(serverEnv().TRIGGER_SECRET_KEY);
}

/**
 * Trigger.dev behind ELISE's BackgroundRuntime port (docs/architecture/14 §4). Payloads carry
 * ids only; the task loads everything else from ELISE services when it runs.
 */
export class TriggerDevBackgroundRuntime implements BackgroundRuntime {
  async enqueue(job: Parameters<BackgroundRuntime["enqueue"]>[0]) {
    if (!isBackgroundConfigured()) {
      throw new AppError("CAPABILITY_UNAVAILABLE", "Background execution is not configured", {
        recovery: "configure",
      });
    }
    const handle = await tasks.trigger<typeof scheduleRunTask>("schedule-run", job.payload, {
      idempotencyKey: job.idempotencyKey,
      tags: [`schedule_run:${job.payload.scheduleRunId}`],
      ttl: "30m",
    });
    return { runtimeJobId: handle.id };
  }

  async cancel(runtimeJobId: string) {
    await runs.cancel(runtimeJobId);
  }
}
