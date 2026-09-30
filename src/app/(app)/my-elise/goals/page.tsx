import { requireAuthContext } from "@/application/auth-context";
import { goalsOverview } from "@/application/native-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { GoalsView } from "@/features/native/goals-view";
import { getT } from "@/lib/i18n/server";

export default async function GoalsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const { goals, linkable } = await goalsOverview(auth);
  return (
    <PageContainer>
      <PageHeader title={t.native.goals.title} subtitle={t.native.goals.subtitle} />
      <GoalsView goals={goals} linkable={linkable} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}
