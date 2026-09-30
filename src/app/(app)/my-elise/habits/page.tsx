import { requireAuthContext } from "@/application/auth-context";
import { habitsOverview } from "@/application/native-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { HabitsView } from "@/features/native/habits-view";
import { getT } from "@/lib/i18n/server";

export default async function HabitsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const { habits, progress } = await habitsOverview(auth);
  return (
    <PageContainer>
      <PageHeader title={t.native.habits.title} subtitle={t.native.habits.subtitle} />
      <HabitsView habits={habits} progress={progress} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}
