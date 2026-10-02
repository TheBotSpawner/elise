import { AbortTaskRunError, schedules, task } from "@trigger.dev/sdk";
import { z } from "zod";

import { indexConversation, indexVoiceSession, sweepRecall } from "@/application/recall-service";
import { withUsageScope } from "@/infrastructure/observability/usage";

/**
 * Thin Trigger.dev entry points for Universal Recall (ADR-012). Indexing is idempotent, so
 * retries are safe; the sweep is the backfill and the safety net for missed turns.
 */

const indexPayload = z
  .object({
    workspaceId: z.uuid(),
    conversationId: z.uuid().optional(),
    sessionId: z.uuid().optional(),
  })
  .refine((p) => Boolean(p.conversationId) !== Boolean(p.sessionId));

export const recallIndexTask = task({
  id: "recall-index",
  maxDuration: 300,
  queue: { concurrencyLimit: 5 },
  retry: { maxAttempts: 3 },
  run: async (payload: z.infer<typeof indexPayload>) => {
    const parsed = indexPayload.safeParse(payload);
    if (!parsed.success) throw new AbortTaskRunError("Invalid recall payload");
    const { workspaceId, conversationId, sessionId } = parsed.data;
    return withUsageScope({ workspaceId, feature: "recall_index" }, () =>
      conversationId
        ? indexConversation(workspaceId, conversationId)
        : indexVoiceSession(workspaceId, sessionId!),
    );
  },
});

/** Backfill one workspace in batches; each batch re-queues itself until nothing is due. */
export const recallBackfillTask = task({
  id: "recall-backfill",
  maxDuration: 900,
  queue: { concurrencyLimit: 1 },
  run: async (payload: { workspaceId: string }) => {
    const workspaceId = z.uuid().parse(payload.workspaceId);
    const result = await sweepRecall({ workspaceId, limit: 100 });
    if (result.remaining > 0 && result.processed > 0) {
      await recallBackfillTask.trigger(
        { workspaceId },
        { idempotencyKey: `recall-backfill:${workspaceId}:${Date.now()}` },
      );
    }
    return result;
  },
});

/** Every 15 minutes: index whatever an interrupted turn or a new deploy left behind. */
export const recallSweepTask = schedules.task({
  id: "recall-sweep",
  cron: "*/15 * * * *",
  maxDuration: 600,
  run: async () => sweepRecall({ limit: 200 }),
});
