import "server-only";

import { summarizeStorage } from "@/core/storage/accounting";
import { startOfDayUtc, todayIn } from "@/core/time";

import type { AuthContext } from "./auth-context";
import { listStoredFiles } from "./storage-service";

/**
 * Settings › Uso (ADR-068): this month, only what ELISE really records — conversations,
 * messages sent, seconds of voice, scheduled runs, stored bytes. Counts from existing rows
 * (RLS: only this person's), no new events and no content. A number that can't be read is
 * null and shows as "—", never as zero. There are no plans, so there are no limits.
 */
export interface AccountUsage {
  since: string;
  conversations: number | null;
  messages: number | null;
  voiceSeconds: number | null;
  scheduledRuns: number | null;
  storageBytes: number | null;
}

const count = (r: { count: number | null; error: unknown }) => (r.error ? null : (r.count ?? 0));

export async function accountUsage(auth: AuthContext, now = new Date()): Promise<AccountUsage> {
  const month = `${todayIn(auth.profile.timezone, now).slice(0, 7)}-01`;
  const since = startOfDayUtc(month, auth.profile.timezone).toISOString();
  const [conversations, messages, voice, runs, storage] = await Promise.all([
    auth.db
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", auth.workspaceId)
      .eq("user_id", auth.userId)
      .gte("created_at", since),
    auth.db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", auth.workspaceId)
      .eq("role", "user")
      .gte("created_at", since),
    auth.db
      .from("usage_events")
      .select("operation, provider, units")
      .eq("workspace_id", auth.workspaceId)
      .eq("user_id", auth.userId)
      .eq("unit", "seconds")
      .gte("created_at", since)
      .limit(20_000),
    auth.db
      .from("schedule_runs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", auth.workspaceId)
      .in("status", ["completed", "completed_with_warning"])
      .gte("scheduled_for", since),
    listStoredFiles(auth).then(
      (files) => summarizeStorage(files).bytes,
      () => null,
    ),
  ]);
  return {
    since: month,
    conversations: count(conversations),
    messages: count(messages),
    // Dictated audio (transcription) and live voice sessions; spoken replies are not "your" voice.
    voiceSeconds: voice.error
      ? null
      : Math.round(
          (voice.data ?? [])
            .filter((e) => e.operation === "transcription" || e.provider === "openai-live")
            .reduce((n, e) => n + Number(e.units ?? 0), 0),
        ),
    scheduledRuns: count(runs),
    storageBytes: storage,
  };
}
