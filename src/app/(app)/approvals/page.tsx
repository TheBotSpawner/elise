import { ShieldCheck } from "lucide-react";

import { listPendingApprovals } from "@/application/approvals-service";
import { requireAuthContext } from "@/application/auth-context";
import { EmptyState, PageContainer, PageHeader } from "@/components/shared/page";
import { ApprovalCenter } from "@/features/approvals/approval-center";
import { getT } from "@/lib/i18n/server";

/** Approval Center: pending actions from chat, background work or other devices. */
export default async function ApprovalsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const approvals = await listPendingApprovals(auth);
  return (
    <PageContainer>
      <PageHeader title={t.approvals.title} />
      {approvals.length === 0 ? (
        <EmptyState icon={ShieldCheck} title={t.approvals.title} body={t.approvals.empty} />
      ) : (
        <ApprovalCenter approvals={approvals} timezone={auth.profile.timezone} />
      )}
    </PageContainer>
  );
}
