import { CircleCheck, Clock } from "lucide-react";

import { requireAuthContext } from "@/application/auth-context";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { Card } from "@/components/ui/card";
import { PROVIDERS } from "@/core/providers/registry";
import { getT } from "@/lib/i18n/server";

/** Built from the provider registry + the workspace's real connections (docs/architecture/07 §26). */
export default async function ConnectionsPage() {
  const [auth, { t }] = await Promise.all([requireAuthContext(), getT()]);
  const { data: connections } = await auth.db
    .from("provider_connections")
    .select("id, provider_key, display_name, account_label, status")
    .eq("workspace_id", auth.workspaceId)
    .neq("status", "disconnected");

  return (
    <PageContainer>
      <PageHeader title={t.connections.title} subtitle={t.connections.subtitle} />
      <ul className="space-y-3">
        {PROVIDERS.map((provider) => {
          const accounts = (connections ?? []).filter((c) => c.provider_key === provider.key);
          const connected = accounts.some((c) => c.status === "connected");
          return (
            <li key={provider.key}>
              <Card className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-medium">{t.providers[provider.key]}</h2>
                    <p className="mt-0.5 text-xs text-muted">
                      {provider.sourceOfTruth === "elise"
                        ? t.connections.sourceOfTruthElise
                        : t.connections.sourceOfTruthExternal}
                      {provider.supportsMultipleAccounts && ` · ${t.connections.multipleAccounts}`}
                    </p>
                  </div>
                  {connected ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs text-success">
                      <CircleCheck className="size-3.5" aria-hidden />
                      {provider.authType === "none"
                        ? t.connections.builtIn
                        : t.connections.connected}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-muted">
                      <Clock className="size-3.5" aria-hidden />
                      {provider.status === "planned"
                        ? t.connections.comingSoon
                        : t.connections.notConnected}
                    </span>
                  )}
                </div>
                <div
                  className="mt-3 flex flex-wrap gap-1.5"
                  aria-label={t.connections.capabilities}
                >
                  {provider.capabilities.map((c) => (
                    <span
                      key={c}
                      className="rounded-md border border-border px-2 py-0.5 text-xs text-muted"
                    >
                      {t.capabilities[c]}
                    </span>
                  ))}
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </PageContainer>
  );
}
