"use client";

import { useRouter } from "next/navigation";

import type { PendingApproval } from "@/application/approvals-service";
import { ApprovalCard } from "@/features/chat/approval-card";

export function ApprovalCenter({
  approvals,
  timezone,
}: {
  approvals: PendingApproval[];
  timezone: string;
}) {
  const router = useRouter();
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {approvals.map((a) => (
        <li key={a.id}>
          <ApprovalCard
            approvalId={a.id}
            summary={a.summary}
            reason={a.reason}
            preview={a.preview}
            timezone={timezone}
            onResolved={() => router.refresh()}
          />
        </li>
      ))}
    </ul>
  );
}
