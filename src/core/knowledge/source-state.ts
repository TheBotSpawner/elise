/**
 * What a connected source (Drive, Notion) looks like to the user: five states, no internals
 * (queued runs, jobs, embeddings), and every one of them finite.
 *
 *   preparing        nothing usable yet: the first sync or its first files are on their way
 *   retrying         a sync that failed or stalled is being tried again
 *   syncing          usable, and a refresh is running (ELISE keeps using the last index)
 *   up_to_date       usable; waiting for the next background check is not a state
 *   needs_attention  the first sync failed or stalled, or a refresh failed
 *
 * Work that never starts or never ends is not "preparing" forever: past these limits it is
 * stalled, the run is closed as failed and the source says it needs attention (ADR-036).
 */
export type SourceState = "preparing" | "retrying" | "up_to_date" | "syncing" | "needs_attention";

/**
 * Where the work of a source is, for the line under its state:
 * queued → discovering (listing the source) → reading → extracting → ocr → indexing.
 */
export type SourcePhase = "queued" | "discovering" | "reading" | "extracting" | "ocr" | "indexing";

export const SOURCE_LIFECYCLE = {
  /** A queued sync the runtime never started. Trigger.dev starts runs within seconds. */
  queuedStallMinutes: 5,
  /**
   * Started work (a sync, an ingestion) that stopped beating. Workers beat at every phase and
   * OCR batch; one attempt is capped at 10 minutes by the task, so this is the lease.
   */
  heartbeatStallMinutes: 8,
  /** Without a heartbeat (rows from before ADR-036): a started sync that never finished. */
  runningStallMinutes: 25,
  /**
   * The lease of a document: past this it died, whatever its heartbeat says (3 attempts of at
   * most 10 minutes plus backoff). Also the fixed limit for queued documents without heartbeats.
   */
  ingestStallMinutes: 40,
  /** A queued document while the runtime is moving: only a queue this old is given up. */
  maxQueuedMinutes: 6 * 60,
  /**
   * A queued document never started AND nothing in the workspace made progress for this long:
   * the runtime isn't executing jobs. A long queue that is moving is never "stalled".
   */
  ingestNotStartedMinutes: 10,
  /** First automatic retry after a failed or stalled sync; doubles each time (capped). */
  retryAfterMinutes: 15,
  maxRetryAfterMinutes: 24 * 60,
  /** A new source whose first sync could not even be queued. */
  unstartedMinutes: 10,
  /** Retry by the user replaces a queued sync that hasn't started after this long. */
  supersedeQueuedSeconds: 60,
} as const;

/** Bounded exponential backoff for automatic retries: 15 min, 30, 60, … up to a day. */
export function retryDelayMinutes(consecutiveFailures: number): number {
  const n = Math.max(1, consecutiveFailures);
  return Math.min(
    SOURCE_LIFECYCLE.retryAfterMinutes * 2 ** Math.min(n - 1, 16),
    SOURCE_LIFECYCLE.maxRetryAfterMinutes,
  );
}

/** Error codes that mean "try again later", not "this source is broken". */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "BACKGROUND_STALLED",
  "TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
  "BACKGROUND_ERROR",
]);

/**
 * Document ingestion as an explicit state machine. A version moves only along these edges;
 * the watchdog and retry use the same table, so no path can resurrect or skip a state.
 */
export type IngestState =
  | "queued"
  | "reading"
  | "extracting"
  | "ocr"
  | "indexing"
  | "ready"
  | "unchanged"
  | "needs_attention"
  | "failed";

const INGEST_EDGES: Record<IngestState, readonly IngestState[]> = {
  queued: ["reading", "failed", "needs_attention"],
  // Notes and Notion pages are text already: reading goes straight to indexing.
  reading: ["extracting", "indexing", "unchanged", "needs_attention", "failed"],
  extracting: ["ocr", "indexing", "unchanged", "needs_attention", "failed"],
  ocr: ["indexing", "unchanged", "needs_attention", "failed"],
  indexing: ["ready", "needs_attention", "failed"],
  ready: ["queued"],
  unchanged: ["queued"],
  // Retry (by the user, or a sync that finds a transient failure) queues it again.
  needs_attention: ["queued"],
  failed: ["queued"],
};

export function canMove(from: IngestState, to: IngestState): boolean {
  return from === to || INGEST_EDGES[from].includes(to);
}

export interface ActiveRun {
  status: "queued" | "running";
  createdAt: string;
  startedAt: string | null;
  /** Last sign of life from the worker (null on rows from before ADR-036). */
  heartbeatAt?: string | null;
}

export function runStalled(run: ActiveRun, now: Date): boolean {
  const minutes = (iso: string) => (now.getTime() - Date.parse(iso)) / 60_000;
  if (run.status === "queued") return minutes(run.createdAt) > SOURCE_LIFECYCLE.queuedStallMinutes;
  if (run.heartbeatAt) return minutes(run.heartbeatAt) > SOURCE_LIFECYCLE.heartbeatStallMinutes;
  return minutes(run.startedAt ?? run.createdAt) > SOURCE_LIFECYCLE.runningStallMinutes;
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
  const usable = Boolean(s.lastSyncedAt) && s.counts.ready > 0;
  // Callers that don't know about runs: the stored status says whether one is going on.
  if (s.activeRun === undefined && s.status === "syncing") return usable ? "syncing" : "preparing";
  const run = s.activeRun ?? null;
  if (run) {
    if (runStalled(run, now)) return "needs_attention";
    if (usable) return "syncing";
    // A new attempt after a failure is not a fresh start: say it's being retried.
    return s.status === "needs_attention" ? "retrying" : "preparing";
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

/**
 * The phase shown with a working source: its sync run first (queued, discovering), then the
 * furthest step any of its documents is in.
 */
export function sourcePhase(
  run: ActiveRun | null,
  itemDetails: readonly (string | null)[],
): SourcePhase | null {
  if (run) return run.status === "queued" ? "queued" : "discovering";
  for (const phase of ["indexing", "ocr", "extracting", "reading"] as const)
    if (itemDetails.includes(phase)) return phase;
  return itemDetails.length ? "queued" : null;
}
