import { AbortTaskRunError, schedules, task } from "@trigger.dev/sdk";
import { z } from "zod";

import { job, withBackgroundSpend } from "@/application/budget-service";
import { runFinanceImport } from "@/application/finance-import";
import { dispatchFinanceSyncs, runFinanceSync } from "@/application/finance-sources";

/**
 * Thin Trigger.dev entry points for Finance (docs/architecture/14). Payloads carry ids only;
 * the application services load everything else, scoped to the workspace.
 */

const importPayload = z.object({ workspaceId: z.uuid(), importId: z.uuid() });

export const financeImportTask = task({
  id: "finance-import",
  maxDuration: 900,
  queue: { concurrencyLimit: 3 },
  // The import cleans up a failed attempt before starting again, so a retry is safe.
  retry: { maxAttempts: 2, minTimeoutInMs: 10_000, maxTimeoutInMs: 60_000, factor: 2 },
  run: async (payload: z.infer<typeof importPayload>) => {
    const parsed = importPayload.safeParse(payload);
    if (!parsed.success) throw new AbortTaskRunError("Invalid import payload");
    const scope = job(parsed.data.workspaceId, "finance_import");
    return withBackgroundSpend(scope, async () => ({
      imported: await runFinanceImport(parsed.data.workspaceId, parsed.data.importId),
    }));
  },
});

const syncPayload = z.object({ workspaceId: z.uuid(), sourceId: z.uuid() });

export const financeSyncTask = task({
  id: "finance-sync",
  maxDuration: 600,
  queue: { concurrencyLimit: 5 },
  retry: { maxAttempts: 1 },
  run: async (payload: z.infer<typeof syncPayload>) => {
    const parsed = syncPayload.safeParse(payload);
    if (!parsed.success) throw new AbortTaskRunError("Invalid sync payload");
    const { workspaceId, sourceId } = parsed.data;
    return withBackgroundSpend(job(workspaceId, "finance_sync"), async () => ({
      counts: await runFinanceSync(workspaceId, sourceId),
    }));
  },
});

/** Every 15 minutes: start the connected-sheet syncs that are due (each about hourly). */
export const financeSyncDispatchTask = schedules.task({
  id: "finance-sync-dispatch",
  cron: "*/15 * * * *",
  maxDuration: 120,
  run: async () => dispatchFinanceSyncs(),
});
