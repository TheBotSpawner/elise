import { requireAuthContext } from "@/application/auth-context";
import { goalsWorkspace } from "@/application/native-service";
import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { GoalsView } from "@/features/native/goals-view";
import { getT } from "@/lib/i18n/server";

export default async function GoalsPage({ searchParams }: PageProps<"/my-elise/goals">) {
  const [auth, { t }, raw] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  // ?archived=1 reads the archive instead; ?goal=… / ?vision=… open a detail (ADR-055).
  const data = await goalsWorkspace(auth, raw.archived === "1");
  return (
    <PageContainer wide>
      <PageHeader title={t.native.goals.title} icon={MY_ELISE_ICONS.goals} />
      <GoalsView key={String(data.archived)} data={data} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}
