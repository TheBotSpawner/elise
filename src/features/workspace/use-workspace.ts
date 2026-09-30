"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { ToolDisplay } from "@/core/agents/tools";
import { approvalDecidedOps } from "@/core/workspace/from-results";
import {
  applyOp,
  applyOps,
  type ActionId,
  type Surface,
  type WorkspaceState,
} from "@/core/workspace/model";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { applyAppearance } from "@/lib/theme";

import {
  getWorkspaceAction,
  presentFromHistoryAction,
  surfaceActionAction,
  surfaceDetailAction,
  workspaceOpAction,
} from "./actions";
import type { ExpandedRef } from "./live-workspace";

type UserOp = Parameters<typeof workspaceOpAction>[1];

/**
 * Browser side of the Live Workspace: user operations apply instantly and persist through the
 * server (queued while a turn streams, so the turn's own saves don't race them); direct
 * actions run on the server through the executor; changes from elsewhere arrive by Realtime.
 */
export function useWorkspaceController({
  workspace,
  setWorkspace,
  getConversationId,
  busy,
  workspaceId,
  outOfSync,
  clearOutOfSync,
  onApprovalResolved,
}: {
  workspace: WorkspaceState;
  setWorkspace: (update: WorkspaceState | ((s: WorkspaceState) => WorkspaceState)) => void;
  getConversationId: () => string | null;
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
  const [expanded, setExpanded] = useState<ExpandedRef | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const queue = useRef<UserOp[]>([]);
  const inFlight = useRef(0);

  const refetch = useCallback(async () => {
    const id = getConversationId();
    if (!id || inFlight.current || queue.current.length) return;
    const result = await getWorkspaceAction(id);
    if (result.ok) setWorkspace(result.value);
  }, [getConversationId, setWorkspace]);

  const persist = useCallback(
    async (op: UserOp) => {
      const id = getConversationId();
      if (!id) return;
      inFlight.current++;
      try {
        await workspaceOpAction(id, op);
      } finally {
        inFlight.current--;
      }
    },
    [getConversationId],
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
    (surface: Surface) => {
      if (expanded?.id === surface.id) setExpanded(null);
      userOp({ op: "dismiss", id: surface.id }, (s) =>
        applyOp(s, { op: "dismiss", id: surface.id, at: new Date().toISOString() }),
      );
    },
    [expanded, userOp],
  );

  const focus = useCallback(
    (id: string) =>
      userOp({ op: "focus", id }, (s) =>
        applyOp(s, { op: "focus", id, at: new Date().toISOString() }),
      ),
    [userOp],
  );

  const expand = useCallback(
    (surface: Surface, itemId: string | null) => {
      setExpanded({ id: surface.id, itemId });
      if (workspace.focusId !== surface.id) focus(surface.id);
    },
    [focus, workspace.focusId],
  );

  const runAction = useCallback(
    async (surface: Surface, action: ActionId, itemId: string | null) => {
      const id = getConversationId();
      if (!id || pending) return;
      setPending(`${surface.id}:${itemId ?? action}`);
      try {
        const result = await surfaceActionAction(id, surface.id, action, itemId);
        if (!result.ok) {
          toast.error(t.errors.codes[result.error.code]);
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
    [getConversationId, pending, setWorkspace, t],
  );

  const loadDetail = useCallback(
    async (surface: Surface, itemId: string | null) => {
      const id = getConversationId();
      if (!id) return null;
      const result = await surfaceDetailAction(id, surface.id, itemId);
      return result.ok ? result.value : { kind: "error" as const, error: result.error };
    },
    [getConversationId],
  );

  /** Re-present a result from earlier in the thread (or focus it if still shown). */
  const showFromThread = useCallback(
    async (surfaceIds: string[], messageId: string | null, callId: string) => {
      const visible = surfaceIds.find((id) => workspace.surfaces.some((s) => s.id === id));
      if (visible) {
        focus(visible);
        document
          .getElementById("live-workspace")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const id = getConversationId();
      if (!id || !messageId || busy) return;
      const result = await presentFromHistoryAction(id, messageId, callId);
      if (result.ok) setWorkspace(result.value);
      else toast.error(t.errors.codes[result.error.code]);
    },
    [busy, focus, getConversationId, setWorkspace, t, workspace.surfaces],
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

  return {
    expanded,
    collapse: useCallback(() => setExpanded(null), []),
    expand,
    dismiss,
    focus,
    runAction,
    loadDetail,
    showFromThread,
    approvalResolved,
    pending,
  };
}
