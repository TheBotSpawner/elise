import type { WorkspaceOp, WorkspaceState } from "./model";

/** One step of an orchestration (e.g. meeting prep searching email), for the activity view. */
export interface ActivityStep {
  id: string;
  /** Canonical tool the step runs ("email.search"); the UI shows a human label. */
  tool: string;
  status: "running" | "done" | "failed" | "unavailable";
}

/**
 * The Live Workspace of the current interaction, as tools see it (ADR-013). Implemented by
 * the application: it streams every change to the browser and persists it.
 */
export interface WorkspacePort {
  state(): WorkspaceState;
  apply(ops: WorkspaceOp[]): void;
  activity(step: ActivityStep): void;
}
