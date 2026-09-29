import { AbortTaskRunError, schedules, task } from "@trigger.dev/sdk";
import { z } from "zod";

import {
  dispatchKnowledgeSyncs,
  reindexKnowledge,
  runIngestion,
  runSync,
} from "@/application/knowledge-background";
import { MAX_INGEST_ATTEMPTS } from "@/core/knowledge/ingest";

/**
 * Thin Trigger.dev entry points for Knowledge (docs/architecture/14 §27-28). Business logic
 * lives in Core and application services.
 */

const ingestPayload = z.object({
  workspaceId: z.uuid(),
  versionId: z.uuid(),
  force: z.boolean().optional(),
});

export const knowledgeIngestTask = task({
  id: "knowledge-ingest",
  maxDuration: 600,
  // A few documents at a time per environment keeps provider and embedding rates sane.
  queue: { concurrencyLimit: 5 },
  retry: {
    maxAttempts: MAX_INGEST_ATTEMPTS,
    factor: 2,
    minTimeoutInMs: 5_000,
    maxTimeoutInMs: 60_000,
    randomize: true,
  },
  run: async (payload: z.infer<typeof ingestPayload>, { ctx }) => {
    const parsed = ingestPayload.safeParse(payload);
    if (!parsed.success) throw new AbortTaskRunError("Invalid ingestion payload");
    return { outcome: await runIngestion({ ...parsed.data, attempt: ctx.attempt.number }) };
  },
});

const syncPayload = z.object({ workspaceId: z.uuid(), syncRunId: z.uuid() });

export const knowledgeSyncTask = task({
  id: "knowledge-sync",
  maxDuration: 600,
  retry: { maxAttempts: 1 },
  run: async (payload: z.infer<typeof syncPayload>) => {
    const parsed = syncPayload.safeParse(payload);
    if (!parsed.success) throw new AbortTaskRunError("Invalid sync payload");
    return { counts: await runSync(parsed.data) };
  },
});

/** Every 10 minutes: start the periodic syncs that are due (each source about hourly). */
export const knowledgeSyncDispatchTask = schedules.task({
  id: "knowledge-sync-dispatch",
  cron: "*/10 * * * *",
  maxDuration: 120,
  run: async () => dispatchKnowledgeSyncs(),
});

/**
 * Internal maintenance: re-index current versions built with an older chunking version or
 * embedding model. Triggered manually from the Trigger.dev dashboard ({} or { workspaceId }).
 */
export const knowledgeReindexTask = task({
  id: "knowledge-reindex",
  maxDuration: 300,
  run: async (payload: { workspaceId?: string }) =>
    reindexKnowledge(z.uuid().optional().parse(payload?.workspaceId) ?? null),
});
