"use client";

import { useRouter } from "next/navigation";

import type { PendingApproval } from "@/application/approvals-service";
import { ApprovalCard } from "@/features/chat/approval-card";

export function ApprovalCenter({ approvals }: { approvals: PendingApproval[] }) {
  const router = useRouter();
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {approvals.map((a) => (
        <li key={a.id}>
          <ApprovalCard
            approvalId={a.id}
            summary={a.summary}
            reason={a.reason}
            onResolved={() => router.refresh()}
          />
        </li>
      ))}
    </ul>
  );
}
