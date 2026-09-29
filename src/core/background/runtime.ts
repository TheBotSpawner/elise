/**
 * Durable execution port (docs/architecture/14 §4). Trigger.dev implements it in
 * infrastructure. Payloads carry ids only — never tokens, never document content.
 */
export type BackgroundJob =
  | { type: "schedule.run"; payload: { workspaceId: string; scheduleRunId: string } }
  | {
      type: "knowledge.ingest";
      payload: { workspaceId: string; versionId: string; force?: boolean };
    }
  | { type: "knowledge.sync"; payload: { workspaceId: string; syncRunId: string } };

export interface BackgroundRuntime {
  /** Same idempotency key → the runtime starts at most one execution. */
  enqueue(job: BackgroundJob & { idempotencyKey: string }): Promise<{ runtimeJobId: string }>;
  cancel(runtimeJobId: string): Promise<void>;
}
