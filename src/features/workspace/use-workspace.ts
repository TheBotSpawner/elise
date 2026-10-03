"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { ToolDisplay } from "@/core/agents/tools";
import type { ThreadRef } from "@/core/interaction";
import { approvalDecidedOps } from "@/core/workspace/approval-ops";
import {
  applyOp,
  applyOps,
  type ActionId,
  type Surface,
  type WorkspaceState,
} from "@/core/workspace/model";
import type { SurfacePayloads } from "@/core/workspace/registry";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { applyAppearance } from "@/lib/theme";

import {
  getWorkspaceAction,
  presentFromHistoryAction,
  refreshWorkspaceAction,
  surfaceActionAction,
  surfaceDetailAction,
  workspaceOpAction,
} from "./actions";

type UserOp = Parameters<typeof workspaceOpAction>[1];

/** A task shown done before the server confirms (rolled back if it refuses). */
export function optimisticComplete(
  state: WorkspaceState,
  surfaceId: string,
  taskId: string,
): WorkspaceState {
  return {
    ...state,
    surfaces: state.surfaces.map((s) => {
      if (s.id !== surfaceId || s.type !== "task_list") return s;
      const p = s.payload as SurfacePayloads["task_list"];
      return {
        ...s,
        payload: {
          ...p,
          items: p.items.map((i) => (i.id === taskId ? { ...i, status: "completed" as const } : i)),
        },
      };
    }),
  };
}

/** Tables whose changes can make a capability's visible collections stale. */
const DOMAIN_TABLES: Record<
  string,
  (
    | "habits"
    | "habit_entries"
    | "goals"
    | "goal_links"
    | "tasks"
    | "task_lists"
    | "finance_transactions"
    | "lists"
    | "list_items"
    | "notes"
  )[]
> = {
  habits: ["habits", "habit_entries"],
  goals: ["goals", "goal_links", "habit_entries"],
  tasks: ["tasks", "task_lists"],
  finance: ["finance_transactions"],
  lists: ["lists", "list_items"],
  notes: ["notes"],
};

/**
 * Browser side of the Live Workspace: user operations apply instantly and persist through the
 * server (queued while a turn streams, so the turn's own saves don't race them); direct
 * actions run on the server through the executor; changes from elsewhere arrive by Realtime.
 */
export function useWorkspaceController({
  workspace,
  setWorkspace,
  getThread,
  busy,
  workspaceId,
  outOfSync,
  clearOutOfSync,
  onApprovalResolved,
}: {
  workspace: WorkspaceState;
  setWorkspace: (update: WorkspaceState | ((s: WorkspaceState) => WorkspaceState)) => void;
  getThread: () => ThreadRef | null;
  busy: boolean;
  workspaceId: string | null;
  outOfSync: boolean;
  clearOutOfSync: () => void;
  onApprovalResolved: (
    approvalId: string,
    decision: "approved" | "rejected",
    display?: ToolDisplay,
  ) => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<string | null>(null);
  const queue = useRef<UserOp[]>([]);
  const inFlight = useRef(0);

  const refetch = useCallback(async () => {
    const id = getThread();
    if (!id || inFlight.current || queue.current.length) return;
    const result = await getWorkspaceAction(id);
    if (result.ok) setWorkspace(result.value);
  }, [getThread, setWorkspace]);

  const persist = useCallback(
    async (op: UserOp) => {
      const id = getThread();
      if (!id) return;
      inFlight.current++;
      try {
        await workspaceOpAction(id, op);
      } finally {
        inFlight.current--;
      }
    },
    [getThread],
  );

  // After a turn: send what the user did meanwhile, then converge on the server's state.
  useEffect(() => {
    if (busy) return;
    const ops = queue.current.splice(0);
    void (async () => {
      for (const op of ops) await persist(op);
      if (ops.length || outOfSync) {
        clearOutOfSync();
        await refetch();
      }
    })();
  }, [busy, outOfSync, persist, refetch, clearOutOfSync]);

  const userOp = useCallback(
    (op: UserOp, local: (s: WorkspaceState) => WorkspaceState) => {
      setWorkspace(local);
      if (busy) queue.current.push(op);
      else void persist(op);
    },
    [busy, persist, setWorkspace],
  );

  const dismiss = useCallback(
    (surface: Surface) =>
      userOp({ op: "dismiss", id: surface.id }, (s) =>
        applyOp(s, { op: "dismiss", id: surface.id, at: new Date().toISOString() }),
      ),
    [userOp],
  );

  /** The same operation ELISE uses for "open that" (ui.focus): click and voice agree. */
  const focus = useCallback(
    (id: string | null, item: string | null = null, compareWith: string | null = null) =>
      userOp({ op: "focus", id, item, compareWith }, (s) =>
        applyOp(s, { op: "focus", id, item, compareWith, at: new Date().toISOString() }),
      ),
    [userOp],
  );

  const pin = useCallback(
    (surface: Surface, pinned: boolean) =>
      userOp({ op: "pin", id: surface.id, pinned }, (s) =>
        applyOp(s, { op: "pin", id: surface.id, pinned, at: new Date().toISOString() }),
      ),
    [userOp],
  );

  const arrange = useCallback(
    (order: "time" | "relevance") =>
      userOp({ op: "arrange", order }, (s) =>
        applyOp(s, { op: "arrange", order, at: new Date().toISOString() }),
      ),
    [userOp],
  );

  /** The context indicator: switch or clear (validated again on the server). */
  const setContext = useCallback(
    (c: Omit<NonNullable<WorkspaceState["context"]>, "turn"> | null) =>
      userOp({ op: "context", contextId: c?.id ?? null }, (s) =>
        applyOp(s, { op: "context", context: c, at: new Date().toISOString() }),
      ),
    [userOp],
  );

  const runAction = useCallback(
    async (surface: Surface, action: ActionId, itemId: string | null) => {
      const id = getThread();
      // Not while a turn streams: its own saves would race this one.
      if (!id || pending || busy) return;
      setPending(`${surface.id}:${itemId ?? action}`);
      // Completing a task is safe to show at once; the server's answer replaces it either way.
      if (action === "complete" && itemId)
        setWorkspace((s) => optimisticComplete(s, surface.id, itemId));
      try {
        const result = await surfaceActionAction(id, surface.id, action, itemId);
        if (!result.ok) {
          toast.error(t.errors.codes[result.error.code]);
          // Rolled back to what the server holds: an optimistic state never outlives a refusal.
          await refetch();
          return;
        }
        const { state, outcome } = result.value;
        if (outcome.status === "succeeded" && outcome.display?.kind === "appearance")
          applyAppearance(outcome.display);
        if (outcome.status === "failed") toast.error(t.errors.codes[outcome.error.code]);
        setWorkspace(state);
      } finally {
        setPending(null);
      }
    },
    [busy, getThread, pending, refetch, setWorkspace, t],
  );

  const loadDetail = useCallback(
    async (surface: Surface, itemId: string | null) => {
      const id = getThread();
      if (!id) return null;
      const result = await surfaceDetailAction(id, surface.id, itemId);
      return result.ok ? result.value : { kind: "error" as const, error: result.error };
    },
    [getThread],
  );

  /** Re-present a result from earlier in the thread (or focus it if still shown). */
  const showFromThread = useCallback(
    async (surfaceIds: string[], messageId: string | null, callId: string) => {
      const visible = surfaceIds.find((id) => workspace.surfaces.some((s) => s.id === id));
      if (visible) {
        focus(visible);
        return;
      }
      const id = getThread();
      if (!id || !messageId || busy) return;
      const result = await presentFromHistoryAction(id, messageId, callId);
      if (result.ok) setWorkspace(result.value);
      else toast.error(t.errors.codes[result.error.code]);
    },
    [busy, focus, getThread, setWorkspace, t, workspace.surfaces],
  );

  const approvalResolved = useCallback(
    (approvalId: string, decision: "approved" | "rejected", display?: ToolDisplay) => {
      onApprovalResolved(approvalId, decision, display);
      userOp({ op: "approval_decided", approvalId, decision }, (s) =>
        applyOps(s, approvalDecidedOps(s, approvalId, decision, display, new Date().toISOString())),
      );
    },
    [onApprovalResolved, userOp],
  );

  // Another tab, the Approval Center or background work changed it.
  useRealtimeRefresh(workspaceId ?? "none", ["live_workspaces"], () => {
    if (!busy && workspaceId) void refetch();
  });

  // The data a visible collection shows changed elsewhere (another tab, Approval Center, a
  // background job): its own read runs again on the server (ADR-029). During a turn the turn
  // reconciles its own writes.
  const shown = useMemo(
    () =>
      [
        ...new Set(
          workspace.surfaces.flatMap((s) => (s.query ? [s.query.tool.split(".")[0]!] : [])),
        ),
      ].sort(),
    [workspace.surfaces],
  );
  const tables = useMemo(() => [...new Set(shown.flatMap((c) => DOMAIN_TABLES[c] ?? []))], [shown]);
  useRealtimeRefresh(workspaceId ?? "none", tables, () => {
    const id = getThread();
    if (busy || !id || !shown.length) return;
    void refreshWorkspaceAction(id, shown).then((r) => r.ok && setWorkspace(r.value));
  });

  return {
    dismiss,
    focus,
    pin,
    arrange,
    setContext,
    runAction,
    loadDetail,
    showFromThread,
    approvalResolved,
    pending,
  };
}
