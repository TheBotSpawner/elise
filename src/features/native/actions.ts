"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { commitImport, previewImport, type ImportKind } from "@/application/native-import";
import { nativeAction, reorderList } from "@/application/native-service";
import type { ToolDisplay } from "@/core/agents/tools";
import { toPublicError, type PublicError } from "@/core/errors";

export type NativeResult<T = ToolDisplay | undefined> =
  { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<NativeResult<T>> {
  try {
    const value = await fn();
    revalidatePath("/my-elise", "layout");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

/**
 * One entry point for My Elise changes: a native capability tool with its arguments. The tool
 * validates the input and the executor applies policy and audit, exactly as for Chat.
 */
export async function nativeActionAction(tool: string, args: unknown, idempotencyKey?: string) {
  return run(async () =>
    nativeAction(
      await requireAuthContext(),
      z.string().max(40).parse(tool),
      args,
      idempotencyKey ? z.string().max(100).parse(idempotencyKey) : undefined,
    ),
  );
}

export async function reorderListAction(listId: string, itemIds: string[]) {
  return run(async () => {
    await reorderList(
      await requireAuthContext(),
      z.uuid().parse(listId),
      z.array(z.uuid()).max(500).parse(itemIds),
    );
    return undefined;
  });
}

const kind = z.enum(["habits", "lists", "goals"]);

export async function previewImportAction(k: ImportKind, csv: string, listName?: string) {
  return run(async () => {
    await requireAuthContext();
    return previewImport(kind.parse(k), z.string().max(2_000_000).parse(csv), listName);
  });
}

export async function commitImportAction(
  k: ImportKind,
  csv: string,
  mapping: Record<string, string>,
  listName?: string,
) {
  return run(async () =>
    commitImport(
      await requireAuthContext(),
      kind.parse(k),
      z.string().max(2_000_000).parse(csv),
      z.record(z.string().max(60), z.string().max(200)).parse(mapping),
      listName ? z.string().trim().min(1).max(120).parse(listName) : undefined,
    ),
  );
}
