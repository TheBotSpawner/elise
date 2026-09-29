"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, useTransition, type KeyboardEvent } from "react";

import { CheckIcon } from "@/components/elise/icons";
import type { ApprovalReason } from "@/core/agents/policy";
import type { ToolDisplay } from "@/core/agents/tools";
import { decideApproval } from "@/features/approvals/actions";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { DisplayCard } from "./result-cards";

const EASE = [0.22, 1, 0.36, 1] as const;

export type ApprovalPhase = "start" | "success" | "error";

/**
 * Inline approval (reference "Approval needed"): what will happen, why ELISE asks, and the
 * decision. Focus moves to Approve; ⌘/Ctrl + Enter approves and Esc chooses "Not now".
 * Once resolved it collapses to a 44 px status row.
 */
export function ApprovalCard({
  approvalId,
  summary,
  reason,
  tool,
  preview,
  timezone,
  autoFocus = false,
  initialResolution = null,
  onResolved,
  onPhase,
}: {
  approvalId: string;
  summary: string;
  reason: string;
  tool?: string;
  /** Exactly what will happen, e.g. the email that will be sent. */
  preview?: ToolDisplay;
  timezone?: string;
  autoFocus?: boolean;
  initialResolution?: "approved" | "rejected" | null;
  onResolved?: (
    approvalId: string,
    decision: "approved" | "rejected",
    display?: ToolDisplay,
  ) => void;
  onPhase?: (phase: ApprovalPhase) => void;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<"approved" | "rejected" | null>(initialResolution);
  const approveRef = useRef<HTMLButtonElement>(null);
  const reasonText = t.approvals.reasons[reason as ApprovalReason] ?? null;

  useEffect(() => {
    if (autoFocus) approveRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  function decide(decision: "approved" | "rejected") {
    if (pending || resolved) return;
    setError(null);
    if (decision === "approved") onPhase?.("start");
    startTransition(async () => {
      const result = await decideApproval(approvalId, decision);
      if (!result.ok) {
        onPhase?.("error");
        setError(
          result.error.code === "CONFLICT"
            ? t.approvals.expired
            : t.errors.codes[result.error.code],
        );
        return;
      }
      if (decision === "approved") onPhase?.("success");
      setResolved(decision);
      onResolved?.(approvalId, decision, result.display);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      decide("approved");
    } else if (e.key === "Escape") {
      e.preventDefault();
      decide("rejected");
    }
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      {resolved ? (
        <motion.div
          key="resolved"
          role="status"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 44 }}
          transition={{ duration: 0.32, ease: EASE }}
          className="flex items-center gap-2.5 rounded-[14px] border border-border px-4 text-sm text-muted"
        >
          <span className={cn("flex", resolved === "approved" ? "text-success" : "text-muted")}>
            <CheckIcon />
          </span>
          <span className="text-fg">
            {resolved === "approved" ? t.approvals.approvedStatus : t.approvals.rejectedStatus}
          </span>
        </motion.div>
      ) : (
        <motion.section
          key="pending"
          aria-label={t.approvals.needsApproval}
          onKeyDown={onKeyDown}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.28, ease: EASE }}
          className="flex flex-col gap-3 rounded-[14px] border border-approval-line bg-approval-bg px-4 py-3.5 md:gap-3.5 md:rounded-2xl md:px-5 md:pt-[18px] md:pb-4"
        >
          <div className="flex items-center gap-2.5">
            <span aria-hidden className="size-1.5 rounded-full bg-approval" />
            <span className="type-label text-approval-text">{t.approvals.needsApproval}</span>
            {tool && (
              <span className="ml-auto hidden font-mono text-[11.5px] text-faint md:inline">
                {tool}
              </span>
            )}
          </div>
          <p className="text-[15px] font-medium md:text-base">{summary}</p>
          {preview && <DisplayCard display={preview} timezone={timezone ?? "UTC"} embedded />}
          {reasonText && (
            <p className="rounded-[10px] bg-surface-2 px-3 py-2.5 text-[13.5px] leading-[1.55] text-muted md:rounded-xl md:px-4 md:py-3.5 md:text-sm">
              {reasonText}
            </p>
          )}
          <div className="grid grid-cols-2 items-center gap-2 md:flex">
            <button
              ref={approveRef}
              type="button"
              onClick={() => decide("approved")}
              disabled={pending}
              className="h-11 rounded-full bg-fg px-[18px] text-sm font-medium text-bg disabled:opacity-60 md:h-10"
            >
              {t.approvals.approve}
            </button>
            <button
              type="button"
              onClick={() => decide("rejected")}
              disabled={pending}
              className="h-11 rounded-full border border-border-strong px-4 text-sm text-fg md:h-10 md:border-0 md:text-muted"
            >
              {t.approvals.notNow}
            </button>
            <span className="ml-auto hidden font-mono text-[11px] text-faint md:inline">
              {t.approvals.shortcut}
            </span>
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-danger-text">
              {error}
            </p>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
