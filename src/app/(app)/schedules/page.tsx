import { CalendarClock } from "lucide-react";

import { EmptyState, PageContainer, PageHeader } from "@/components/shared/page";
import { getT } from "@/lib/i18n/server";

export default async function SchedulesPage() {
  const { t } = await getT();
  return (
    <PageContainer>
      <PageHeader title={t.schedules.title} />
      <EmptyState
        icon={CalendarClock}
        title={t.schedules.emptyTitle}
        body={t.schedules.emptyBody}
      />
    </PageContainer>
  );
}
