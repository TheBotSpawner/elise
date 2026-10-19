import { listsWorkspace } from "@/application/native-service";

import { one, type RouteLoader } from "../../route-contract";

export const load = (async (auth, { search }) => ({
  lists: await listsWorkspace(auth),
  workspaceId: auth.workspaceId,
  focus: one(search.focus) ?? null,
})) satisfies RouteLoader<unknown>;

export type ListsProps = Awaited<ReturnType<typeof load>>;
