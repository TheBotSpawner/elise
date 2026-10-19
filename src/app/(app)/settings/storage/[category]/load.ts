import { notFound } from "next/navigation";

import { storedFilesIn } from "@/application/storage-service";
import { STORAGE_CATEGORIES, type StorageCategory } from "@/core/storage/accounting";

import type { RouteLoader } from "../../../route-contract";

export const load = (async (auth, { params }) => {
  const { category } = params;
  if (!(STORAGE_CATEGORIES as readonly string[]).includes(category)) notFound();
  const c = category as StorageCategory;
  return { category: c, files: await storedFilesIn(auth, c) };
}) satisfies RouteLoader<unknown>;

export type StorageCategoryProps = Awaited<ReturnType<typeof load>>;
