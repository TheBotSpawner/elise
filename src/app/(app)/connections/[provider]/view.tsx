"use client";

import { PageContainer } from "@/components/shared/page";
import { ProviderDetail } from "@/features/connections/provider-detail";
import { StructuredSourcesSection } from "@/features/structured/sources-section";
import { useI18n } from "@/lib/i18n/client";

import type { ProviderProps } from "./load";

export function View({ providerId, connections, configured, opened, sources }: ProviderProps) {
  const { t } = useI18n();
  return (
    <PageContainer>
      <ProviderDetail
        providerId={providerId}
        connections={connections}
        configured={configured}
        opened={opened}
      >
        {sources && (
          <StructuredSourcesSection
            sources={sources}
            hasNotion={connections.some(
              (c) => c.providerKey === "notion" && c.status === "connected",
            )}
            t={t}
          />
        )}
      </ProviderDetail>
    </PageContainer>
  );
}
