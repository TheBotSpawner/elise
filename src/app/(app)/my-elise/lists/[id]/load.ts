import { redirect } from "next/navigation";

import type { RouteLoader } from "../../../route-contract";

/** A list opens as its column on the Lists workspace (ADR-051); old links keep working. */
export const load = (async (_auth, { params }) =>
  redirect(
    `/my-elise/lists?focus=${encodeURIComponent(params.id)}`,
  )) satisfies RouteLoader<unknown>;
