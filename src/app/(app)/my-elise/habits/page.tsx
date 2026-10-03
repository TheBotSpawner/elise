import { requireAuthContext } from "@/application/auth-context";
import { habitsOverview } from "@/application/native-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { isIsoDate } from "@/core/time";
import { HabitsView } from "@/features/native/habits-view";
import { getT } from "@/lib/i18n/server";

export default async function HabitsPage({ searchParams }: PageProps<"/my-elise/habits">) {
  const [auth, { t }, raw] = await Promise.all([requireAuthContext(), getT(), searchParams]);
  // ?week=YYYY-MM-DD shows a past week (its days stay editable history).
  const week = typeof raw.week === "string" && isIsoDate(raw.week) ? raw.week : null;
  const { habits, progress, week: shown } = await habitsOverview(auth, week);
  return (
    <PageContainer>
      <PageHeader title={t.native.habits.title} subtitle={t.native.habits.subtitle} />
      <HabitsView habits={habits} progress={progress} workspaceId={auth.workspaceId} week={shown} />
    </PageContainer>
  );
}
