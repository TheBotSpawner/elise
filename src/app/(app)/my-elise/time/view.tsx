"use client";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { TimeSettings } from "@/features/time/time-settings";
import { useI18n } from "@/lib/i18n/client";

/** My Elise → Time (ADR-045). The timers themselves come from the page-wide time store. */
export function View() {
  const { t } = useI18n();
  return (
    <PageContainer>
      <PageHeader
        title={t.time.settings.title}
        icon={MY_ELISE_ICONS.time}
        info={[t.time.settings.subtitle]}
      />
      <TimeSettings />
    </PageContainer>
  );
}
