"use client";

import { createClient } from "@/infrastructure/supabase/client";

import {
  completeUploadsAction,
  prepareUploadsAction,
  prepareVersionAction,
  type KnowledgeResult,
} from "./actions";
import { KNOWLEDGE_BUCKET_NAME } from "./constants";

/**
 * Browser → private Storage directly, with one-time signed upload URLs the server issued after
 * checking the Space belongs to this workspace. The server then verifies each object exists
 * before ELISE starts reading it.
 */
async function put(target: { path: string; token: string; contentType: string }, file: File) {
  const { error } = await createClient()
    .storage.from(KNOWLEDGE_BUCKET_NAME)
    .uploadToSignedUrl(target.path, target.token, file, { contentType: target.contentType });
  return !error;
}

export async function uploadFiles(
  spaceId: string,
  files: File[],
): Promise<KnowledgeResult<number>> {
  const prepared = await prepareUploadsAction(
    spaceId,
    files.map((f) => ({ name: f.name, size: f.size })),
  );
  if (!prepared.ok) return prepared;
  const done: string[] = [];
  await Promise.all(
    prepared.value.map(async (target, i) => {
      if (await put(target, files[i]!)) done.push(target.versionId);
    }),
  );
  // Every prepared version is completed: failed uploads are marked as such, not left waiting.
  const completed = await completeUploadsAction(prepared.value.map((t) => t.versionId));
  if (!completed.ok) return completed;
  return { ok: true, value: done.length };
}

export async function uploadVersion(itemId: string, file: File): Promise<KnowledgeResult<number>> {
  const prepared = await prepareVersionAction(itemId, { name: file.name, size: file.size });
  if (!prepared.ok) return prepared;
  const ok = await put(prepared.value, file);
  const completed = await completeUploadsAction([prepared.value.versionId]);
  if (!completed.ok) return completed;
  return { ok: true, value: ok ? 1 : 0 };
}
