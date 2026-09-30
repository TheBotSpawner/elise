import "server-only";

import type { RecordValue } from "@/core/capabilities/structured";
import { AppError } from "@/core/errors";
import {
  isBackgroundConfigured,
  TriggerDevBackgroundRuntime,
} from "@/infrastructure/background/trigger/runtime";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import type { Json } from "@/infrastructure/supabase/database.types";

export interface BulkInput {
  sourceId: string;
  recordRefs: string[];
  change: { values?: Record<string, RecordValue>; archive?: boolean };
  actionId: string | null;
}

/**
 * Queues an approved bulk change: the job row keeps exactly the approved record ids and
 * change; Trigger.dev gets only the job id (docs/architecture/14 §4).
 */
export async function startStructuredBulk(workspaceId: string, userId: string, input: BulkInput) {
  if (!isBackgroundConfigured()) {
    throw new AppError(
      "CAPABILITY_UNAVAILABLE",
      "Large changes run in the background, which isn't configured on this server. Narrow it to 25 records or fewer.",
      { recovery: "configure" },
    );
  }
  const db = createAdminClient();
  const { data, error } = await db
    .from("background_jobs")
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      job_type: "structured.bulk",
      input: input as unknown as Json,
      progress_total: input.recordRefs.length,
      progress_current: 0,
    })
    .select("id")
    .single();
  if (error) throw new AppError("INTERNAL_ERROR", "Could not queue the change", { cause: error });
  const { runtimeJobId } = await new TriggerDevBackgroundRuntime().enqueue({
    type: "structured.bulk",
    payload: { workspaceId, jobId: data.id },
    idempotencyKey: `structured-bulk:${data.id}`,
  });
  await db
    .from("background_jobs")
    .update({ runtime_job_id: runtimeJobId })
    .eq("id", data.id)
    .eq("workspace_id", workspaceId);
}
