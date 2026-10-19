import { listStoredFiles } from "@/application/storage-service";
import { summarizeStorage } from "@/core/storage/accounting";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => ({
  summary: summarizeStorage(await listStoredFiles(auth)),
})) satisfies RouteLoader<unknown>;

export type StorageProps = Awaited<ReturnType<typeof load>>;
