import { requireAuthContext } from "@/application/auth-context";
import { habitsWorkspace, parseHabitParams } from "@/application/native-service";
import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { HabitsView } from "@/features/native/habits-view";
import { getT } from "@/lib/i18n/server";

export default async function HabitsPage({ searchParams }: PageProps<"/my-elise/habits">) {
  const [auth, { t }, raw] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  // ?view=week|month|year|custom&date=…&from=…&to=…&status=… (ADR-053); only that range is read.
  const data = await habitsWorkspace(auth, parseHabitParams(raw));
  return (
    <PageContainer wide>
      <PageHeader title={t.native.habits.title} icon={MY_ELISE_ICONS.habits} />
      <HabitsView data={data} workspaceId={auth.workspaceId} />
    </PageContainer>
  );
}
