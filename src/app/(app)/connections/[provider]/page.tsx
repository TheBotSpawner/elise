import { notFound } from "next/navigation";

import { requireAuthContext } from "@/application/auth-context";
import { configuredProviders, listConnections } from "@/application/connections-service";
import { listStructuredSources } from "@/application/structured-service";
import { PageContainer } from "@/components/shared/page";
import { catalogEntry } from "@/core/providers/catalog";
import { ProviderDetail } from "@/features/connections/provider-detail";
import { StructuredSourcesSection } from "@/features/structured/sources-section";
import { getT } from "@/lib/i18n/server";

/** One provider and its accounts (ADR-043): deep-linkable, e.g. /connections/google. */
export default async function ProviderPage({
  params,
  searchParams,
}: PageProps<"/connections/[provider]">) {
  const [{ provider }, query] = await Promise.all([params, searchParams]);
  const entry = catalogEntry(provider);
  if (!entry) notFound();
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const list = await listConnections(auth);
  const configured = configuredProviders(list)[entry.id] ?? false;
  const opened = typeof query.opened === "string" ? query.opened : null;
  // Notion's mapped databases belong to Notion's page, not the Hub.
  const sources = entry.id === "notion" ? await listStructuredSources(auth).catch(() => []) : null;
  return (
    <PageContainer>
      <ProviderDetail
        providerId={entry.id}
        connections={list.connections}
        configured={configured}
        opened={opened}
      >
        {sources && (
          <StructuredSourcesSection
            sources={sources}
            hasNotion={list.connections.some(
              (c) => c.providerKey === "notion" && c.status === "connected",
            )}
            t={t}
          />
        )}
      </ProviderDetail>
    </PageContainer>
  );
}
