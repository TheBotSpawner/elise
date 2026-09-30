"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import {
  discoverDatabases,
  inspectDatabase,
  refreshSchema,
  saveMapping,
  testSource,
  unmapSource,
  updatePermissions,
} from "@/application/structured-service";
import { toPublicError, type PublicError } from "@/core/errors";

export type StructuredResult<T = null> = { ok: true; value: T } | { ok: false; error: PublicError };

async function run<T>(fn: () => Promise<T>): Promise<StructuredResult<T>> {
  try {
    const value = await fn();
    revalidatePath("/connections", "layout");
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toPublicError(error) };
  }
}

const id = z.uuid();
const dsId = z.string().min(1).max(100);

export async function discoverAction(connectionId: string, query: string) {
  return run(async () =>
    discoverDatabases(
      await requireAuthContext(),
      id.parse(connectionId),
      z.string().max(100).parse(query),
    ),
  );
}

export async function inspectAction(connectionId: string, dataSourceId: string) {
  return run(async () =>
    inspectDatabase(await requireAuthContext(), id.parse(connectionId), dsId.parse(dataSourceId)),
  );
}

export async function saveMappingAction(input: unknown, sourceId?: string) {
  return run(async () =>
    saveMapping(await requireAuthContext(), input, sourceId ? id.parse(sourceId) : undefined),
  );
}

export async function refreshSchemaAction(sourceId: string) {
  return run(async () => refreshSchema(await requireAuthContext(), id.parse(sourceId)));
}

export async function testSourceAction(sourceId: string) {
  return run(async () => testSource(await requireAuthContext(), id.parse(sourceId)));
}

export async function updateSourceAction(
  sourceId: string,
  patch: {
    create?: boolean;
    update?: boolean;
    archive?: boolean;
    context?: string | null;
    name?: string;
  },
) {
  return run(async () =>
    updatePermissions(
      await requireAuthContext(),
      id.parse(sourceId),
      z
        .object({
          create: z.boolean().optional(),
          update: z.boolean().optional(),
          archive: z.boolean().optional(),
          context: z.string().max(200).nullable().optional(),
          name: z.string().max(120).optional(),
        })
        .strict()
        .parse(patch),
    ),
  );
}

export async function unmapAction(sourceId: string) {
  return run(async () => unmapSource(await requireAuthContext(), id.parse(sourceId)));
}
