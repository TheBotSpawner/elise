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
  listSpaces,
  prepareNewVersion,
  prepareUploads,
  removeSource,
  retryItem,
  searchNotion,
  syncNow,
  updateSpace,
  type UploadTarget,
} from "@/application/knowledge-service";
import {
  assertSectionPlacement,
  createSection,
  ensureSectionProfile,
  moveItem,
  setSectionPurpose,
} from "@/application/sections-service";
import { SECTION_PURPOSES } from "@/core/contexts/model";
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

/** Spaces to offer as a destination (chat attachments). A read: nothing to revalidate. */
export async function listSpacesAction(): Promise<KnowledgeResult<{ id: string; path: string }[]>> {
  try {
    const spaces = await listSpaces(await requireAuthContext());
    return { ok: true, value: spaces.map((s) => ({ id: s.id, path: s.path })) };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/** Every input is validated again by the service; nothing from the client is trusted. */
export interface SpaceFields {
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
}

export async function createSpaceAction(input: SpaceFields & { parentId: string | null }) {
  return run(async () => {
    const auth = await requireAuthContext();
    const fields = {
      name: input.name,
      description: input.description ?? null,
      icon: input.icon ?? null,
      color: input.color ?? null,
    };
    // Inside a Space, a new Space is a Section (ADR-018) — always with its context.
    return input.parentId
      ? (
          await createSection(auth, {
            ...fields,
            parentId: id.parse(input.parentId),
            purpose: "general",
          })
        ).id
      : createSpace(auth, fields);
  });
}

const sectionInput = z
  .object({
    parentId: id,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    purpose: z.enum(SECTION_PURPOSES),
  })
  .strict();

/** "+ New section": the Section and its context, in one step. */
export async function createSectionAction(input: z.input<typeof sectionInput>) {
  return run(async () => {
    const q = sectionInput.parse(input);
    return createSection(await requireAuthContext(), q);
  });
}

export async function setSectionPurposeAction(spaceId: string, purpose: string) {
  return run(async () =>
    setSectionPurpose(
      await requireAuthContext(),
      id.parse(spaceId),
      z.enum(SECTION_PURPOSES).parse(purpose),
    ),
  );
}

/** An uploaded document moves between a Space and its Sections; nothing is copied. */
export async function moveItemAction(itemId: string, spaceId: string) {
  return run(async () => moveItem(await requireAuthContext(), id.parse(itemId), id.parse(spaceId)));
}

/** Name, description, icon and color; the service validates each (curated icons/colors). */
export async function updateSpaceAction(spaceId: string, input: SpaceFields) {
  return run(async () =>
    updateSpace(await requireAuthContext(), id.parse(spaceId), {
      name: input.name,
      description: input.description ?? null,
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    }),
  );
}

export async function moveSpaceAction(spaceId: string, parentId: string | null) {
  return run(async () => {
    const auth = await requireAuthContext();
    const target = parentId ? id.parse(parentId) : null;
    // One visible level: only into a top-level Space, and only a Space without Sections.
    await assertSectionPlacement(auth, id.parse(spaceId), target);
    await updateSpace(auth, spaceId, { parentId: target });
    if (target) await ensureSectionProfile(auth, spaceId);
  });
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
