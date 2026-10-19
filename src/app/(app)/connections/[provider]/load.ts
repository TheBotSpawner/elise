import { notFound } from "next/navigation";

import { configuredProviders, listConnections } from "@/application/connections-service";
import { listStructuredSources } from "@/application/structured-service";
import { catalogEntry } from "@/core/providers/catalog";

import { one, type RouteLoader } from "../../route-contract";

export const load = (async (auth, { params, search }) => {
  const entry = catalogEntry(params.provider ?? "");
  if (!entry) notFound();
  const list = await listConnections(auth);
  const configured = configuredProviders(list)[entry.id] ?? false;
  const opened = one(search.opened) ?? null;
  // Notion's mapped databases belong to Notion's page, not the Hub.
  const sources = entry.id === "notion" ? await listStructuredSources(auth).catch(() => []) : null;
  return { providerId: entry.id, connections: list.connections, configured, opened, sources };
}) satisfies RouteLoader<unknown>;

export type ProviderProps = Awaited<ReturnType<typeof load>>;
