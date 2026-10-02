/**
 * What a connected source (Drive, Notion) looks like to the user: four states, no internals
 * (queued runs, jobs, embeddings), and every one of them finite.
 *
 *   preparing        nothing usable yet: the first sync or its first files are on their way
 *   syncing          usable, and a refresh is running (ELISE keeps using the last index)
 *   up_to_date       usable; waiting for the next background check is not a state
 *   needs_attention  the first sync failed or stalled, or a refresh failed
 *
 * Work that never starts or never ends is not "preparing" forever: past these limits it is
 * stalled, the run is closed as failed and the source says it needs attention.
 */
export type SourceState = "preparing" | "up_to_date" | "syncing" | "needs_attention";

export const SOURCE_LIFECYCLE = {
  /** A queued sync the runtime never started. Trigger.dev starts runs within seconds. */
  queuedStallMinutes: 10,
  /** A started sync that never finished (the task's own limit is 10 minutes). */
  runningStallMinutes: 25,
  /** A document version whose ingestion never finished. */
  ingestStallMinutes: 30,
  /** After a failed or stalled sync, the next automatic attempt waits this long. */
  retryAfterMinutes: 30,
  /** A new source whose first sync could not even be queued. */
  unstartedMinutes: 10,
} as const;

/** Error codes that mean "try again later", not "this source is broken". */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "BACKGROUND_STALLED",
  "TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "BACKGROUND_ERROR",
]);

export interface ActiveRun {
  status: "queued" | "running";
  createdAt: string;
  startedAt: string | null;
}

export function runStalled(run: ActiveRun, now: Date): boolean {
  const minutes = (iso: string) => (now.getTime() - Date.parse(iso)) / 60_000;
  return run.status === "queued"
    ? minutes(run.createdAt) > SOURCE_LIFECYCLE.queuedStallMinutes
    : minutes(run.startedAt ?? run.createdAt) > SOURCE_LIFECYCLE.runningStallMinutes;
}

export interface SourceFacts {
  /** Stored status: idle | syncing | ready | needs_attention | disconnected | archived. */
  status: string;
  /** Last sync whose listing succeeded. */
  lastSyncedAt: string | null;
  createdAt?: string;
  /** The sync in progress, if any. */
  activeRun?: ActiveRun | null;
  /** Items of the source by readiness. */
  counts: { ready: number; processing: number; attention: number };
  /**
   * Uploads and notes never sync: they are containers whose documents each have their own
   * state. Only connected sources (Drive, Notion) go through the sync lifecycle.
   */
  container?: boolean;
}

export function sourceState(s: SourceFacts, now: Date = new Date()): SourceState {
  if (s.container) return s.counts.processing > 0 ? "syncing" : "up_to_date";
  if (s.status === "disconnected") return "needs_attention";
  // Callers that don't know about runs: the stored status says whether one is going on.
  if (s.activeRun === undefined && s.status === "syncing")
    return s.lastSyncedAt && s.counts.ready > 0 ? "syncing" : "preparing";
  const run = s.activeRun ?? null;
  if (run) {
    if (runStalled(run, now)) return "needs_attention";
    return s.lastSyncedAt && s.counts.ready > 0 ? "syncing" : "preparing";
  }
  if (s.status === "needs_attention") return "needs_attention";
  if (!s.lastSyncedAt) {
    // Never synced and nothing running: about to start, unless it never could.
    const age = s.createdAt ? (now.getTime() - Date.parse(s.createdAt)) / 60_000 : 0;
    return age > SOURCE_LIFECYCLE.unstartedMinutes ? "needs_attention" : "preparing";
  }
  // Listed, files still being read for the first time: nothing usable yet.
  if (s.counts.processing > 0 && s.counts.ready === 0) return "preparing";
  if (s.counts.processing > 0) return "syncing";
  return "up_to_date";
}
