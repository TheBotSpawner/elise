"use client";

import { MY_ELISE_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { MethodsPanel } from "@/features/methods/methods-panel";
import { useI18n } from "@/lib/i18n/client";

import type { MethodsProps } from "./load";

export function View({ methods, spaces, opened, draft }: MethodsProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <PageHeader
        title={t.methods.title}
        icon={MY_ELISE_ICONS.methods}
        info={[t.methods.subtitle]}
      />
      <MethodsPanel
        methods={methods}
        spaces={spaces}
        opened={opened}
        initialDraft={draft}
        heading={false}
      />
    </PageContainer>
  );
}
