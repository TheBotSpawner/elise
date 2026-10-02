import type { WorkspaceOp, WorkspaceState } from "./model";
import type { SurfacePayloads } from "./registry";
import type { ToolDisplay } from "../agents/tools";

/** The UI applies these when an approval is decided: no schema code, so the browser can import it. */
const BACKGROUND_TOOLS = new Set(["structured.bulkUpdate"]);

export function approvalDecidedOps(
  state: WorkspaceState,
  approvalId: string,
  decision: "approved" | "rejected",
  display: ToolDisplay | undefined,
  at: string,
): WorkspaceOp[] {
  return state.surfaces
    .filter(
      (s) =>
        s.type === "approval" &&
        (s.payload as SurfacePayloads["approval"]).approvalId === approvalId,
    )
    .map((s) => {
      const p = s.payload as SurfacePayloads["approval"];
      const background = decision === "approved" && BACKGROUND_TOOLS.has(p.tool) && !p.background;
      return {
        op: "update" as const,
        id: s.id,
        patch: {
          state: background ? ("loading" as const) : ("ready" as const),
          payload: {
            ...p,
            decision,
            ...(display ? { display } : {}),
            ...(background ? { background: "running" as const } : {}),
          },
        },
        at,
      };
    });
}
