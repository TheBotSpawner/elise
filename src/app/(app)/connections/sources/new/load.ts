import { getStructuredSource, notionWorkspaces } from "@/application/structured-service";

import { one, type RouteLoader } from "../../../route-contract";

export const load = (async (auth, { search }) => {
  const editId = one(search.edit) ?? null;
  const [workspaces, edit] = await Promise.all([
    notionWorkspaces(auth),
    editId ? getStructuredSource(auth, editId).catch(() => null) : null,
  ]);
  return { workspaces, edit };
}) satisfies RouteLoader<unknown>;

export type NewStructuredSourceProps = Awaited<ReturnType<typeof load>>;
