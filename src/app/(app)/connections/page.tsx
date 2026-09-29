import { Suspense } from "react";

import { requireAuthContext } from "@/application/auth-context";
import { listConnections } from "@/application/connections-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { ConnectionsView } from "@/features/connections/connections-view";
import { getT } from "@/lib/i18n/server";

/** What ELISE can access, per account. The user stays in control (docs/product/04 §13-15). */
export default async function ConnectionsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const { connections, googleAvailable, notionAvailable } = await listConnections(auth);

  return (
    <PageContainer>
      <PageHeader title={t.connections.title} subtitle={t.connections.subtitle} />
      <Suspense>
        <ConnectionsView
          connections={connections}
          googleAvailable={googleAvailable}
          notionAvailable={notionAvailable}
        />
      </Suspense>
    </PageContainer>
  );
}
