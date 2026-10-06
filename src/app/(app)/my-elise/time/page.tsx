import { PageContainer, PageHeader } from "@/components/shared/page";
import { TimeSettings } from "@/features/time/time-settings";
import { getT } from "@/lib/i18n/server";

/** My Elise → Time (ADR-045). The timers themselves come from the page-wide time store. */
export default async function TimePage() {
  const { t } = await getT();
  return (
    <PageContainer>
      <PageHeader title={t.time.settings.title} subtitle={t.time.settings.subtitle} />
      <TimeSettings />
    </PageContainer>
  );
}
