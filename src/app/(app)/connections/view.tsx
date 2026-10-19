"use client";

import { Suspense } from "react";

import { SECTION_ICONS } from "@/components/elise/navigation/nav-items";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ConnectionsHub } from "@/features/connections/hub";
import { useI18n } from "@/lib/i18n/client";

import type { ConnectionsProps } from "./load";

export function View({ accounts, configured, modules }: ConnectionsProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <PageHeader
        title={t.connections.title}
        icon={SECTION_ICONS.connections}
        info={[t.connections.subtitle]}
      />
      <Suspense>
        <ConnectionsHub accounts={accounts} configured={configured} modules={modules} />
      </Suspense>
    </PageContainer>
  );
}
