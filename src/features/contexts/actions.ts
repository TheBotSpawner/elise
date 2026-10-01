"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import {
  auditContextChange,
  createContextProfile,
  deleteContextProfile,
  setContextArchived,
  updateContextProfile,
} from "@/application/contexts-service";
import { CONTEXT_KINDS, LINK_TYPES } from "@/core/contexts/model";
import { toPublicError, type PublicError } from "@/core/errors";
import { SPACE_COLORS, SPACE_ICONS } from "@/core/knowledge/appearance";
import { isIsoDate } from "@/core/time";
import { toNewLinks } from "@/core/tools/contexts";

type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const value = await fn();
    revalidatePath("/my-elise/contexts", "layout");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

const id = z.uuid();
const text = (max: number) => z.string().trim().max(max);
const date = z
  .string()
  .refine((v) => v === "" || isIsoDate(v), "YYYY-MM-DD")
  .transform((v) => v || null);
const link = z
  .object({
    type: z.enum(LINK_TYPES),
    resourceId: z.string().trim().min(1).max(600).optional(),
    value: z.string().trim().min(1).max(320).optional(),
    label: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const createInput = z
  .object({
    kind: z.enum(CONTEXT_KINDS),
    name: text(80).min(1),
  })
  .strict();

export async function createContextAction(input: z.input<typeof createInput>) {
  return run(async () => {
    const auth = await requireAuthContext();
    const q = createInput.parse(input);
    const profile = await createContextProfile(
      auth,
      { kind: q.kind, name: q.name, links: [] },
      "user_ui",
    );
    await auditContextChange(auth, "context.created", profile.id, { kind: q.kind });
    return { id: profile.id };
  });
}

const updateInput = z
  .object({
    name: text(80).min(1).optional(),
    description: text(1000).optional(),
    aliases: z.array(text(80).min(1)).max(12).optional(),
    instructions: text(1000).optional(),
    icon: z.enum(SPACE_ICONS).optional(),
    accent: z.enum(SPACE_COLORS).optional(),
    study: z
      .object({
        targetDate: date.optional(),
        objective: text(500).optional(),
        level: text(60).optional(),
      })
      .strict()
      .optional(),
    addLinks: z.array(link).max(10).optional(),
    removeLinkIds: z.array(id).max(20).optional(),
  })
  .strict();

export async function updateContextAction(contextId: string, input: z.input<typeof updateInput>) {
  return run(async () => {
    const auth = await requireAuthContext();
    const q = updateInput.parse(input);
    const profile = await updateContextProfile(
      auth,
      id.parse(contextId),
      {
        ...(q.name ? { name: q.name } : {}),
        ...(q.description !== undefined ? { description: q.description || null } : {}),
        ...(q.aliases ? { aliases: q.aliases } : {}),
        ...(q.instructions !== undefined ? { instructions: q.instructions || null } : {}),
        ...(q.icon ? { icon: q.icon } : {}),
        ...(q.accent ? { accent: q.accent } : {}),
        ...(q.study
          ? {
              study: {
                ...(q.study.targetDate !== undefined ? { targetDate: q.study.targetDate } : {}),
                ...(q.study.objective !== undefined
                  ? { objective: q.study.objective || null }
                  : {}),
                ...(q.study.level !== undefined ? { level: q.study.level || null } : {}),
              },
            }
          : {}),
        ...(q.addLinks?.length ? { addLinks: toNewLinks(q.addLinks) } : {}),
        ...(q.removeLinkIds?.length ? { removeLinkIds: q.removeLinkIds } : {}),
      },
      "user_ui",
    );
    await auditContextChange(auth, "context.updated", profile.id, {
      links_added: q.addLinks?.length ?? 0,
      links_removed: q.removeLinkIds?.length ?? 0,
    });
    return profile;
  });
}

export async function archiveContextAction(contextId: string, archived: boolean) {
  return run(async () => {
    const auth = await requireAuthContext();
    const profile = await setContextArchived(
      auth,
      id.parse(contextId),
      z.boolean().parse(archived),
    );
    await auditContextChange(auth, archived ? "context.archived" : "context.restored", profile.id);
    return { id: profile.id };
  });
}

export async function deleteContextAction(contextId: string, deleteStudyProgress: boolean) {
  return run(async () => {
    const auth = await requireAuthContext();
    const target = id.parse(contextId);
    await deleteContextProfile(auth, target, {
      deleteStudyProgress: z.boolean().parse(deleteStudyProgress),
    });
    await auditContextChange(auth, "context.deleted", target, {
      study_progress: deleteStudyProgress,
    });
    return { id: target };
  });
}
