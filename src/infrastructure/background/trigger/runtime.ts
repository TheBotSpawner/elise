import { runs, tasks } from "@trigger.dev/sdk";

import { serverEnv } from "@/config/server-env";
import type { BackgroundJob, BackgroundRuntime } from "@/core/background/runtime";
import { AppError } from "@/core/errors";

export function isBackgroundConfigured(): boolean {
  return Boolean(serverEnv().TRIGGER_SECRET_KEY);
}

const TASKS: Record<
  BackgroundJob["type"],
  { id: string; tag: (p: BackgroundJob["payload"]) => string }
> = {
  "schedule.run": {
    id: "schedule-run",
    tag: (p) => `schedule_run:${(p as { scheduleRunId: string }).scheduleRunId}`,
  },
  "knowledge.ingest": {
    id: "knowledge-ingest",
    tag: (p) => `knowledge_version:${(p as { versionId: string }).versionId}`,
  },
  "knowledge.sync": {
    id: "knowledge-sync",
    tag: (p) => `knowledge_sync:${(p as { syncRunId: string }).syncRunId}`,
  },
  "finance.import": {
    id: "finance-import",
    tag: (p) => `finance_import:${(p as { importId: string }).importId}`,
  },
  "finance.sync": {
    id: "finance-sync",
    tag: (p) => `finance_source:${(p as { sourceId: string }).sourceId}`,
  },
};

/**
 * Trigger.dev behind ELISE's BackgroundRuntime port (docs/architecture/14 §4). Payloads carry
 * ids only; the task loads everything else from ELISE services when it runs.
 */
export class TriggerDevBackgroundRuntime implements BackgroundRuntime {
  async enqueue(job: BackgroundJob & { idempotencyKey: string }) {
    if (!isBackgroundConfigured()) {
      throw new AppError("CAPABILITY_UNAVAILABLE", "Background execution is not configured", {
        recovery: "configure",
      });
    }
    const task = TASKS[job.type];
    const handle = await tasks.trigger(task.id, job.payload, {
      idempotencyKey: job.idempotencyKey,
      tags: [task.tag(job.payload), `workspace:${job.payload.workspaceId}`],
      ttl: "30m",
    });
    return { runtimeJobId: handle.id };
  }

  async cancel(runtimeJobId: string) {
    await runs.cancel(runtimeJobId);
  }
}
