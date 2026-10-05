"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import {
  draftMethod,
  exportMethod,
  importMethod,
  methodDetail,
  methodStore,
} from "@/application/methods-service";
import { AppError, toPublicError, type PublicError } from "@/core/errors";
import {
  METHOD_LIMITS,
  normalizeHints,
  normalizeMethod,
  REFERENCE_KINDS,
} from "@/core/skills/model";
import { rollbackMethod } from "@/core/tools/methods";

/**
 * Methods in the UI (ADR-040 §J): the same store ELISE uses. Every content change is a version
 * (the database counts them), recorded as the user's own edit.
 */

export type MethodResult<T> = { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<MethodResult<T>> {
  try {
    const value = await fn();
    revalidatePath("/my-elise/methods");
    revalidatePath("/knowledge/spaces/[id]", "page");
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: toPublicError(
        error instanceof z.ZodError
          ? new AppError("VALIDATION_ERROR", "Review the method", { recovery: "review" })
          : error,
      ),
    };
  }
}

const fields = z
  .object({
    name: z.string().trim().min(1).max(METHOD_LIMITS.name),
    description: z.string().trim().min(1).max(METHOD_LIMITS.description),
    instructions: z.string().trim().min(1).max(METHOD_LIMITS.instructions),
    hints: z.string().max(800).default(""),
    spaceId: z.uuid().nullable(),
  })
  .strict();

const toInput = (q: z.infer<typeof fields>) =>
  normalizeMethod({ ...q, hints: normalizeHints(q.hints.split(",")) }, { generated: false });

/** `fromItemId`: created from a Knowledge document, which stays attached as its source. */
export async function createMethodAction(input: z.input<typeof fields>, fromItemId?: string) {
  return run(async () => {
    const auth = await requireAuthContext();
    const store = methodStore(auth);
    const m = await store.create(toInput(fields.parse(input)), {
      source: "user_ui",
      summary: auth.profile.locale === "es" ? "Creado" : "Created",
    });
    if (fromItemId)
      await store.addReference(m.id, {
        kind: "reference",
        source: "knowledge_item",
        itemId: z.uuid().parse(fromItemId),
      });
    return { id: m.id };
  });
}

export async function updateMethodAction(
  id: string,
  input: z.input<typeof fields>,
  summary: string,
) {
  return run(async () => {
    const auth = await requireAuthContext();
    const m = await methodStore(auth).update(z.uuid().parse(id), toInput(fields.parse(input)), {
      source: "user_ui",
      summary:
        z.string().trim().max(METHOD_LIMITS.changeSummary).parse(summary) ||
        (auth.profile.locale === "es" ? "Editado" : "Edited"),
    });
    return { version: m.version };
  });
}

export async function setMethodStatusAction(id: string, status: "active" | "archived") {
  return run(async () => {
    const auth = await requireAuthContext();
    await methodStore(auth).setStatus(
      z.uuid().parse(id),
      z.enum(["active", "archived"]).parse(status),
    );
    return null;
  });
}

/** Undo / Restore: a new version with an earlier one's content. */
export async function rollbackMethodAction(id: string, version: number) {
  return run(async () => {
    const auth = await requireAuthContext();
    const { restored } = await rollbackMethod(
      methodStore(auth),
      z.uuid().parse(id),
      z.number().int().min(1).parse(version),
      auth.profile.locale,
    );
    return { version: restored.version };
  });
}

export async function methodDetailAction(id: string) {
  return run(async () => methodDetail(await requireAuthContext(), z.uuid().parse(id)));
}

const kind = z.enum(REFERENCE_KINDS);

export async function addTextReferenceAction(
  id: string,
  input: { kind: string; title: string; content: string },
) {
  return run(async () => {
    const auth = await requireAuthContext();
    const q = z
      .object({
        kind,
        title: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(METHOD_LIMITS.referenceChars),
      })
      .parse(input);
    await methodStore(auth).addReference(z.uuid().parse(id), { ...q, source: "text" });
    return null;
  });
}

/** A file uploaded through the attachment pipeline (verified bytes, extracted text). */
export async function addFileReferenceAction(id: string, attachmentId: string, refKind: string) {
  return run(async () => {
    const auth = await requireAuthContext();
    await methodStore(auth).addReference(z.uuid().parse(id), {
      kind: kind.parse(refKind),
      source: "attachment",
      attachmentId: z.uuid().parse(attachmentId),
    });
    return null;
  });
}

export async function removeReferenceAction(id: string, referenceId: string) {
  return run(async () => {
    const auth = await requireAuthContext();
    await methodStore(auth).removeReference(z.uuid().parse(id), z.uuid().parse(referenceId));
    return null;
  });
}

/** "Contale a ELISE cómo querés que lo haga": a draft to review, nothing saved. */
export async function draftMethodAction(text: string) {
  return run(async () =>
    draftMethod(await requireAuthContext(), z.string().trim().min(10).max(8000).parse(text)),
  );
}

export async function importMethodAction(text: string, fileName: string, spaceId: string | null) {
  return run(async () => {
    const auth = await requireAuthContext();
    const m = await importMethod(auth, {
      text: z.string().min(1).max(100_000).parse(text),
      fileName: z.string().max(255).parse(fileName),
      spaceId: z.uuid().nullable().parse(spaceId),
    });
    return { id: m.id };
  });
}

export async function exportMethodAction(id: string) {
  return run(async () => exportMethod(await requireAuthContext(), z.uuid().parse(id)));
}
