import { AbortTaskRunError, schedules, task } from "@trigger.dev/sdk";
import { z } from "zod";

import { dispatchSchemaChecks, runStructuredBulk } from "@/application/structured-service";
import { withUsageScope } from "@/infrastructure/observability/usage";

/**
 * Thin Trigger.dev entry points for Structured Data (ADR-011). Single reads and writes stay
 * interactive; only approved bulk changes and periodic schema checks run here.
 */

const bulkPayload = z.object({ workspaceId: z.uuid(), jobId: z.uuid() });

export const structuredBulkTask = task({
  id: "structured-bulk",
  maxDuration: 900,
  queue: { concurrencyLimit: 2 },
  // Never retried automatically: some records may already be changed.
  retry: { maxAttempts: 1 },
  run: async (payload: z.infer<typeof bulkPayload>) => {
    const parsed = bulkPayload.safeParse(payload);
    if (!parsed.success) throw new AbortTaskRunError("Invalid bulk payload");
    const scope = { workspaceId: parsed.data.workspaceId, feature: "structured_bulk" };
    return withUsageScope(scope, async () => ({
      result: await runStructuredBulk(parsed.data.workspaceId, parsed.data.jobId),
    }));
  },
});

/** Hourly: notice renamed, removed or retyped fields before the next request needs them. */
export const structuredSchemaDispatchTask = schedules.task({
  id: "structured-schema-check",
  cron: "7 * * * *",
  maxDuration: 300,
  run: async () => dispatchSchemaChecks(),
});
