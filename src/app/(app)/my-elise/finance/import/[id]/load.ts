import { notFound } from "next/navigation";
import { z } from "zod";

import type { RouteLoader } from "../../../../route-contract";

export const load = (async (auth, { params }) => {
  const { id } = params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { data } = await auth.db
    .from("imports")
    .select("status")
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();
  if (!data) notFound();
  return { importId: id, status: data.status };
}) satisfies RouteLoader<unknown>;

export type FinanceImportProps = Awaited<ReturnType<typeof load>>;
