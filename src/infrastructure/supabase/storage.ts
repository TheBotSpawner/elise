import "server-only";

import { AppError } from "@/core/errors";

import { createAdminClient } from "./admin";

/**
 * Private originals of uploaded Knowledge (bucket `knowledge-originals`). Paths always start
 * with the workspace, and every access is checked against it: a path from another workspace is
 * refused even if someone guessed it. Access is only through short-lived signed URLs.
 */
export const KNOWLEDGE_BUCKET = "knowledge-originals";
const SIGNED_URL_SECONDS = 300;

export function originalPath(
  workspaceId: string,
  itemId: string,
  versionId: string,
  filename: string,
) {
  const safe =
    filename
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(-120) || "file";
  return `workspace/${workspaceId}/knowledge/${itemId}/${versionId}/${safe}`;
}

function assertOwned(workspaceId: string, path: string) {
  if (!path.startsWith(`workspace/${workspaceId}/knowledge/`) || path.includes("..")) {
    throw new AppError("PERMISSION_DENIED", "That file does not belong to this workspace");
  }
}

/** A one-time upload URL for exactly this path (the browser uploads directly to Storage). */
export async function createUploadUrl(workspaceId: string, path: string) {
  assertOwned(workspaceId, path);
  const { data, error } = await createAdminClient()
    .storage.from(KNOWLEDGE_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data)
    throw new AppError("INTERNAL_ERROR", "Could not prepare the upload", { cause: error });
  return { path: data.path, token: data.token };
}

/** Size of the uploaded object, or null if it isn't there (upload never completed). */
export async function uploadedSize(workspaceId: string, path: string): Promise<number | null> {
  assertOwned(workspaceId, path);
  const dir = path.slice(0, path.lastIndexOf("/"));
  const name = path.slice(path.lastIndexOf("/") + 1);
  const { data } = await createAdminClient()
    .storage.from(KNOWLEDGE_BUCKET)
    .list(dir, { search: name });
  const file = data?.find((f) => f.name === name);
  return file ? Number((file.metadata as { size?: number } | null)?.size ?? 0) : null;
}

/** Writes a document the server produced itself (e.g. a saved web page) to Knowledge storage. */
export async function uploadOriginal(
  workspaceId: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
) {
  assertOwned(workspaceId, path);
  const { error } = await createAdminClient()
    .storage.from(KNOWLEDGE_BUCKET)
    .upload(path, bytes, { contentType, upsert: false });
  if (error) throw new AppError("INTERNAL_ERROR", "Could not store the document", { cause: error });
}

export async function downloadOriginal(workspaceId: string, path: string): Promise<Uint8Array> {
  assertOwned(workspaceId, path);
  const { data, error } = await createAdminClient().storage.from(KNOWLEDGE_BUCKET).download(path);
  if (error || !data)
    throw new AppError("NOT_FOUND", "The original file is missing", { cause: error });
  return new Uint8Array(await data.arrayBuffer());
}

export async function signedDownloadUrl(workspaceId: string, path: string, filename: string) {
  assertOwned(workspaceId, path);
  const { data, error } = await createAdminClient()
    .storage.from(KNOWLEDGE_BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS, { download: filename });
  if (error || !data)
    throw new AppError("INTERNAL_ERROR", "Could not open the file", { cause: error });
  return data.signedUrl;
}

export async function removeOriginals(workspaceId: string, paths: string[]) {
  paths.forEach((p) => assertOwned(workspaceId, p));
  if (paths.length) await createAdminClient().storage.from(KNOWLEDGE_BUCKET).remove(paths);
}

// ── Finance imports (bucket `finance-imports`) ───────────────────────────────
// Spreadsheets waiting to be imported: workspace/{workspace_id}/finance-imports/{import_id}/{file}.

export const FINANCE_IMPORTS_BUCKET = "finance-imports";

export function financeImportPath(workspaceId: string, importId: string, filename: string) {
  const safe =
    filename
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(-120) || "file";
  return `workspace/${workspaceId}/finance-imports/${importId}/${safe}`;
}

function assertFinanceOwned(workspaceId: string, path: string) {
  if (!path.startsWith(`workspace/${workspaceId}/finance-imports/`) || path.includes("..")) {
    throw new AppError("PERMISSION_DENIED", "That file does not belong to this workspace");
  }
}

export async function createFinanceUploadUrl(workspaceId: string, path: string) {
  assertFinanceOwned(workspaceId, path);
  const { data, error } = await createAdminClient()
    .storage.from(FINANCE_IMPORTS_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data)
    throw new AppError("INTERNAL_ERROR", "Could not prepare the upload", { cause: error });
  return { path: data.path, token: data.token };
}

export async function downloadFinanceImport(workspaceId: string, path: string) {
  assertFinanceOwned(workspaceId, path);
  const { data, error } = await createAdminClient()
    .storage.from(FINANCE_IMPORTS_BUCKET)
    .download(path);
  if (error || !data)
    throw new AppError("NOT_FOUND", "The uploaded file is missing. Upload it again.", {
      cause: error,
      recovery: "retry",
    });
  return new Uint8Array(await data.arrayBuffer());
}

export async function removeFinanceImport(workspaceId: string, path: string) {
  assertFinanceOwned(workspaceId, path);
  await createAdminClient().storage.from(FINANCE_IMPORTS_BUCKET).remove([path]);
}

// ── Chat attachments (bucket `chat-attachments`, ADR-031) ────────────────────
// Files given to one message: workspace/{workspace_id}/chat/{attachment_id}/{file}.

export const CHAT_ATTACHMENTS_BUCKET = "chat-attachments";

export function chatAttachmentPath(workspaceId: string, attachmentId: string, filename: string) {
  const safe =
    filename
      .normalize("NFKD")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(-120) || "file";
  return `workspace/${workspaceId}/chat/${attachmentId}/${safe}`;
}

function assertChatOwned(workspaceId: string, path: string) {
  if (!path.startsWith(`workspace/${workspaceId}/chat/`) || path.includes("..")) {
    throw new AppError("PERMISSION_DENIED", "That file does not belong to this workspace");
  }
}

export async function createChatUploadUrl(workspaceId: string, path: string) {
  assertChatOwned(workspaceId, path);
  const { data, error } = await createAdminClient()
    .storage.from(CHAT_ATTACHMENTS_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data)
    throw new AppError("INTERNAL_ERROR", "Could not prepare the upload", { cause: error });
  return { path: data.path, token: data.token };
}

/** The uploaded bytes, or null if the upload never completed. */
export async function downloadChatAttachment(
  workspaceId: string,
  path: string,
): Promise<Uint8Array | null> {
  assertChatOwned(workspaceId, path);
  const { data, error } = await createAdminClient()
    .storage.from(CHAT_ATTACHMENTS_BUCKET)
    .download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

export async function removeChatAttachments(workspaceId: string, paths: string[]) {
  paths.forEach((p) => assertChatOwned(workspaceId, p));
  if (paths.length) await createAdminClient().storage.from(CHAT_ATTACHMENTS_BUCKET).remove(paths);
}
