"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import {
  addExternalSource,
  archiveSpace,
  browseDrive,
  completeUploads,
  createSpace,
  deleteItem,
  prepareNewVersion,
  prepareUploads,
  removeSource,
  retryItem,
  searchNotion,
  syncNow,
  updateSpace,
  type UploadTarget,
} from "@/application/knowledge-service";
import { toPublicError, type PublicError } from "@/core/errors";

export type KnowledgeResult<T = null> = { ok: true; value: T } | { ok: false; error: PublicError };

const id = z.uuid();

async function run<T>(fn: () => Promise<T>): Promise<KnowledgeResult<T>> {
  try {
    const value = await fn();
    revalidatePath("/knowledge", "layout");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** Every input is validated again by the service; nothing from the client is trusted. */
export async function createSpaceAction(name: string, parentId: string | null) {
  return run(async () =>
    createSpace(await requireAuthContext(), {
      name,
      parentId: parentId ? id.parse(parentId) : null,
    }),
  );
}

export async function renameSpaceAction(spaceId: string, name: string) {
  return run(async () => updateSpace(await requireAuthContext(), id.parse(spaceId), { name }));
}

export async function moveSpaceAction(spaceId: string, parentId: string | null) {
  return run(async () =>
    updateSpace(await requireAuthContext(), id.parse(spaceId), {
      parentId: parentId ? id.parse(parentId) : null,
    }),
  );
}

export async function archiveSpaceAction(spaceId: string) {
  return run(async () => archiveSpace(await requireAuthContext(), id.parse(spaceId)));
}

export async function prepareUploadsAction(
  spaceId: string,
  files: { name: string; size: number }[],
): Promise<KnowledgeResult<UploadTarget[]>> {
  return run(async () => prepareUploads(await requireAuthContext(), id.parse(spaceId), files));
}

export async function prepareVersionAction(
  itemId: string,
  file: { name: string; size: number },
): Promise<KnowledgeResult<UploadTarget>> {
  return run(async () => prepareNewVersion(await requireAuthContext(), id.parse(itemId), file));
}

export async function completeUploadsAction(versionIds: string[]) {
  return run(async () =>
    completeUploads(await requireAuthContext(), z.array(id).max(20).parse(versionIds)),
  );
}

export async function retryItemAction(itemId: string) {
  return run(async () => retryItem(await requireAuthContext(), id.parse(itemId)));
}

export async function deleteItemAction(itemId: string) {
  return run(async () => deleteItem(await requireAuthContext(), id.parse(itemId)));
}

export async function syncNowAction(sourceId: string) {
  return run(async () => syncNow(await requireAuthContext(), id.parse(sourceId)));
}

export async function removeSourceAction(sourceId: string) {
  return run(async () => removeSource(await requireAuthContext(), id.parse(sourceId)));
}

export async function browseDriveAction(connectionId: string, folderId: string) {
  return run(async () =>
    browseDrive(
      await requireAuthContext(),
      id.parse(connectionId),
      z
        .string()
        .max(200)
        .regex(/^[\w-]*$/)
        .parse(folderId),
    ),
  );
}

export async function searchNotionAction(connectionId: string, query: string) {
  return run(async () =>
    searchNotion(
      await requireAuthContext(),
      id.parse(connectionId),
      z.string().max(100).parse(query),
    ),
  );
}

export async function addSourceAction(input: {
  spaceId: string;
  connectionId: string;
  provider: "google" | "notion";
  selection: { id: string; kind: string; name: string }[];
}) {
  return run(async () =>
    addExternalSource(await requireAuthContext(), {
      spaceId: id.parse(input.spaceId),
      connectionId: id.parse(input.connectionId),
      provider: z.enum(["google", "notion"]).parse(input.provider),
      selection: input.selection,
    }),
  );
}
