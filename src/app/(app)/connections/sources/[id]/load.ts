import { notFound } from "next/navigation";
import { z } from "zod";

import { getStructuredSource } from "@/application/structured-service";

import type { RouteLoader } from "../../../route-contract";

export const load = (async (auth, { params }) => {
  const id = params.id ?? "";
  if (!z.uuid().safeParse(id).success) notFound();
  const source = await getStructuredSource(auth, id).catch(() => null);
  if (!source) notFound();
  return { source, workspaceId: auth.workspaceId };
}) satisfies RouteLoader<unknown>;

export type StructuredSourceProps = Awaited<ReturnType<typeof load>>;
