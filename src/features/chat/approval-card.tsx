"use client";

import { ShieldQuestion } from "lucide-react";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import type { ApprovalReason } from "@/core/agents/policy";
import type { ToolDisplay } from "@/core/agents/tools";
import { decideApproval } from "@/features/approvals/actions";
import { useI18n } from "@/lib/i18n/client";

/** Inline approval: what will happen and why Elise is asking (docs/architecture/15 §28-30). */
export function ApprovalCard({
  approvalId,
  summary,
  reason,
  onResolved,
}: {
  approvalId: string;
  summary: string;
  reason: string;
  onResolved?: (approvalId: string, display?: ToolDisplay, rejected?: boolean) => void;
}) {
  const { t } = useI18n();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const reasonText = t.approvals.reasons[reason as ApprovalReason] ?? null;

  function decide(decision: "approved" | "rejected") {
    setError(null);
    startTransition(async () => {
      const result = await decideApproval(approvalId, decision);
      if (!result.ok) {
        setError(
          result.error.code === "CONFLICT"
            ? t.approvals.expired
            : t.errors.codes[result.error.code],
        );
        return;
      }
      onResolved?.(approvalId, result.display, decision === "rejected");
    });
  }

  return (
    <div className="max-w-sm rounded-xl border border-warning/40 bg-surface p-3">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-warning">
        <ShieldQuestion className="size-3.5" aria-hidden />
        {t.approvals.waiting}
      </p>
      <p className="text-sm font-medium">{summary}</p>
      {reasonText && <p className="mt-0.5 text-xs text-muted">{reasonText}</p>}
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => decide("approved")} disabled={pending}>
          {t.approvals.approve}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => decide("rejected")} disabled={pending}>
          {t.approvals.reject}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
