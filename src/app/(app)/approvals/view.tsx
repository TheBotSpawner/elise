"use client";

import { ShieldCheck } from "lucide-react";

import { EmptyState, PageContainer, PageHeader } from "@/components/shared/page";
import { ApprovalCenter } from "@/features/approvals/approval-center";
import { useI18n } from "@/lib/i18n/client";

import type { ApprovalsProps } from "./load";

export function View({ approvals, timezone }: ApprovalsProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <PageHeader title={t.approvals.title} />
      {approvals.length === 0 ? (
        <EmptyState icon={ShieldCheck} title={t.approvals.title} body={t.approvals.empty} />
      ) : (
        <ApprovalCenter approvals={approvals} timezone={timezone} />
      )}
    </PageContainer>
  );
}
