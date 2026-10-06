import { Suspense } from "react";

import { requireAuthContext } from "@/application/auth-context";
import { configuredProviders, listConnections } from "@/application/connections-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ConnectionsHub } from "@/features/connections/hub";
import { getT } from "@/lib/i18n/server";

/**
 * The Connections Hub (ADR-043): providers, searchable, from persisted connection metadata only
 * (no provider is called to draw it). Accounts and capabilities live in each provider's page.
 */
export default async function ConnectionsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const list = await listConnections(auth);
  return (
    <PageContainer>
      <PageHeader title={t.connections.title} subtitle={t.connections.subtitle} />
      <Suspense>
        <ConnectionsHub accounts={list.connections} configured={configuredProviders(list)} />
      </Suspense>
    </PageContainer>
  );
}
