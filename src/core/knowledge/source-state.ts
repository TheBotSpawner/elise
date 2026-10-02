/**
 * What a connected source (Drive, Notion) looks like to the user: four states, no internals
 * (queued runs, jobs, embeddings). A source that has something usable indexed is "up to date"
 * between background checks — waiting for the next check is not a state worth showing.
 */
export type SourceState = "preparing" | "up_to_date" | "syncing" | "needs_attention";

export interface SourceFacts {
  /** Stored status: idle | syncing | ready | needs_attention | disconnected | archived. */
  status: string;
  lastSyncedAt: string | null;
  /** Items of the source by readiness. */
  counts: { ready: number; processing: number; attention: number };
}

export function sourceState(s: SourceFacts): SourceState {
  if (s.status === "needs_attention" || s.status === "disconnected") return "needs_attention";
  // Nothing usable yet: the first sync, or its files still being read.
  const preparing = !s.lastSyncedAt || (s.counts.processing > 0 && s.counts.ready === 0);
  if (preparing) return "preparing";
  if (s.status === "syncing" || s.counts.processing > 0) return "syncing";
  return "up_to_date";
}
