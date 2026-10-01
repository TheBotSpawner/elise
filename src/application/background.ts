import "server-only";

import { AppError } from "@/core/errors";
import {
  dispatchDue,
  executeRun,
  resumeAfterApproval,
  type RunnerPorts,
} from "@/core/schedules/runner";
import type { RunStatus } from "@/core/schedules/schedule";
import { getAIProvider } from "@/infrastructure/ai";
import { TriggerDevBackgroundRuntime } from "@/infrastructure/background/trigger/runtime";
import { logger } from "@/infrastructure/observability/logger";
import { createAdminClient } from "@/infrastructure/supabase/admin";
import { SupabaseScheduleStore } from "@/infrastructure/supabase/repositories/schedules";

import type { AuthContext } from "./auth-context";
import { morningBriefHandler } from "./morning-brief-service";

/**
 * Background work runs without a browser session. It acts as the schedule's owner with the
 * service role, after the runner revalidated that the owner is still an active member; every
 * query stays scoped to that workspace, and tools go through the same policies as chat.
 */
export async function ownerContext(workspaceId: string, userId: string): Promise<AuthContext> {
  const db = createAdminClient();
  const { data: profile } = await db
    .from("user_profiles")
    .select(
      "display_name, preferred_language, timezone, onboarding_status, theme, accent, voice_enabled, voice_output, voice_language, voice_name, voice_continuous, voice_barge_in, voice_wake_enabled, voice_wake_phrase",
    )
    .eq("id", userId)
    .maybeSingle();
  if (!profile) throw new AppError("AUTH_ERROR", "The schedule owner no longer exists");
  return {
    db,
    userId,
    email: null,
    workspaceId,
    profile: {
      displayName: profile.display_name,
      locale: profile.preferred_language,
      timezone: profile.timezone,
      onboardingStatus: profile.onboarding_status,
      theme: profile.theme,
      accent: profile.accent,
      voice: {
        enabled: profile.voice_enabled,
        speak: profile.voice_output,
        language: profile.voice_language,
        voice: profile.voice_name,
        continuous: profile.voice_continuous ?? true,
        bargeIn: profile.voice_barge_in ?? true,
        wakeEnabled: profile.voice_wake_enabled ?? false,
        wakePhrase: profile.voice_wake_phrase ?? "elise",
      },
    },
  };
}

/** Background work that belongs to a workspace (Knowledge, Finance) runs as its owner. */
export async function workspaceContext(workspaceId: string): Promise<AuthContext> {
  const { data } = await createAdminClient()
    .from("workspaces")
    .select("owner_user_id, archived_at")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!data || data.archived_at) throw new AppError("NOT_FOUND", "Workspace not found");
  return ownerContext(workspaceId, data.owner_user_id);
}

export function runnerPorts(): RunnerPorts {
  return {
    store: new SupabaseScheduleStore(createAdminClient()),
    runtime: new TriggerDevBackgroundRuntime(),
    handlers: {
      morning_brief: morningBriefHandler({ authFor: ownerContext, ai: getAIProvider }),
    },
    now: () => new Date(),
    log: (event, fields) => logger.info(event, fields),
  };
}

/** Entry point for the background runtime's schedule-run task. */
export async function executeScheduleRun(job: {
  workspaceId: string;
  scheduleRunId: string;
  attempt: number;
}): Promise<RunStatus> {
  return executeRun(runnerPorts(), job);
}

/** Entry point for the background runtime's minute tick. */
export async function dispatchDueSchedules(): Promise<{ started: number }> {
  return dispatchDue(runnerPorts());
}

/** Called when an approval is decided: a schedule run waiting on it can finish. */
export async function resumeScheduleRunAfterApproval(
  approvalId: string,
  decision: { approved: boolean; succeeded: boolean; errorCode?: string | null },
): Promise<void> {
  await resumeAfterApproval(runnerPorts(), approvalId, decision);
}
