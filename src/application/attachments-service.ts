import "server-only";

import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_TYPES,
  attachmentType,
  checkAttachment,
  imageMatchesType,
  type SentAttachment,
} from "@/core/attachments/model";
import { AppError } from "@/core/errors";
import type { ThreadRef } from "@/core/interaction";
import { documentText } from "@/core/knowledge/model";
import { contentMatchesType, parseDocument } from "@/infrastructure/knowledge/parsers";
import { logger } from "@/infrastructure/observability/logger";
import {
  chatAttachmentPath,
  createChatUploadUrl,
  downloadChatAttachment,
  removeChatAttachments,
} from "@/infrastructure/supabase/storage";

import type { AuthContext } from "./auth-context";

/**
 * Chat attachments (ADR-031). A file dropped or picked in the composer is staged for the
 * user's unsent draft (browser → private Storage through a one-time signed URL), verified by
 * its bytes, and becomes part of exactly the turn it is sent with. Never Knowledge: nothing
 * is indexed or kept outside that conversation. Unsent staged files expire.
 */

export interface StagedUpload {
  id: string;
  path: string;
  token: string;
  contentType: string;
}

/** What a turn receives from its attachments (the model input), plus what the turn keeps. */
export interface TurnAttachments {
  sent: SentAttachment[];
  documents: { id: string; name: string; text: string; truncated: boolean }[];
  images: { id: string; name: string; dataUrl: string }[];
}

export async function stageAttachments(
  auth: AuthContext,
  files: { name: string; size: number }[],
): Promise<StagedUpload[]> {
  if (files.length < 1 || files.length > ATTACHMENT_LIMITS.perMessage)
    throw new AppError("VALIDATION_ERROR", "Too many files for one message");
  await expireStaged(auth).catch((error) =>
    logger.warn("attachments.cleanup_failed", { cause: error }),
  );
  const staged: StagedUpload[] = [];
  for (const file of files) {
    const problem = checkAttachment(file);
    if (problem)
      throw new AppError(
        "VALIDATION_ERROR",
        problem === "unsupported" ? "That file type can't be used yet" : "That file is too large",
        { details: { problem, name: file.name.slice(0, 120) } },
      );
    const id = crypto.randomUUID();
    const contentType = attachmentType(file.name)!;
    const path = chatAttachmentPath(auth.workspaceId, id, file.name);
    const { error } = await auth.db.from("chat_attachments").insert({
      id,
      workspace_id: auth.workspaceId,
      user_id: auth.userId,
      name: file.name.slice(0, 255),
      mime_type: contentType,
      size_bytes: file.size,
      storage_path: path,
    });
    if (error)
      throw new AppError("INTERNAL_ERROR", "Could not prepare the upload", { cause: error });
    const { token } = await createChatUploadUrl(auth.workspaceId, path);
    staged.push({ id, path, token, contentType });
  }
  return staged;
}

async function own(auth: AuthContext, ids: string[]) {
  const { data } = await auth.db
    .from("chat_attachments")
    .select("*")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .in("id", ids);
  return data ?? [];
}

/** After the browser uploaded: the server checks the real bytes before the file can be sent. */
export async function completeAttachment(auth: AuthContext, id: string): Promise<{ id: string }> {
  const [row] = await own(auth, [id]);
  if (!row || row.status === "sent") throw new AppError("NOT_FOUND", "Attachment not found");
  if (row.status === "ready") return { id };
  const data = await downloadChatAttachment(auth.workspaceId, row.storage_path);
  const kind = ATTACHMENT_TYPES[row.mime_type]?.kind;
  const max = kind === "image" ? ATTACHMENT_LIMITS.maxImageBytes : ATTACHMENT_LIMITS.maxBytes;
  const problem = !data
    ? "missing"
    : data.byteLength === 0 || data.byteLength > max
      ? "size"
      : (kind === "image" ? imageMatchesType : contentMatchesType)(row.mime_type, data)
        ? null
        : "content";
  if (problem) {
    await discard(auth, [row]);
    throw new AppError(
      "VALIDATION_ERROR",
      problem === "missing"
        ? "The upload did not finish"
        : problem === "size"
          ? "That file is too large"
          : "This file's content doesn't match its type",
      { details: { problem }, recovery: "retry" },
    );
  }
  const { error } = await auth.db
    .from("chat_attachments")
    .update({ status: "ready", size_bytes: data!.byteLength })
    .eq("id", id)
    .eq("user_id", auth.userId);
  if (error)
    throw new AppError("INTERNAL_ERROR", "Could not save the attachment", { cause: error });
  return { id };
}

/** Removed from the draft: the staged file goes too. A sent attachment stays with its turn. */
export async function removeAttachment(auth: AuthContext, id: string) {
  const rows = (await own(auth, [id])).filter((r) => r.status !== "sent");
  await discard(auth, rows);
}

async function discard(auth: AuthContext, rows: { id: string; storage_path: string }[]) {
  if (!rows.length) return;
  await removeChatAttachments(
    auth.workspaceId,
    rows.map((r) => r.storage_path),
  );
  await auth.db
    .from("chat_attachments")
    .delete()
    .eq("user_id", auth.userId)
    .neq("status", "sent")
    .in(
      "id",
      rows.map((r) => r.id),
    );
}

/** Staged files nobody sent (a closed tab, a reload) don't accumulate. */
async function expireStaged(auth: AuthContext) {
  const { data } = await auth.db
    .from("chat_attachments")
    .select("id, storage_path")
    .eq("workspace_id", auth.workspaceId)
    .eq("user_id", auth.userId)
    .neq("status", "sent")
    .lt("created_at", new Date(Date.now() - ATTACHMENT_LIMITS.stagedTtlMs).toISOString())
    .limit(50);
  await discard(auth, data ?? []);
}

/**
 * The attachments of the turn being sent: exactly these ids, all the author's own and verified,
 * or the turn is refused before anything is written (never sent without a file the UI showed).
 */
export async function loadTurnAttachments(
  auth: AuthContext,
  ids: string[],
): Promise<TurnAttachments | null> {
  if (!ids.length) return null;
  const unique = [...new Set(ids)];
  if (unique.length > ATTACHMENT_LIMITS.perMessage)
    throw new AppError("VALIDATION_ERROR", "Too many files for one message");
  const rows = await own(auth, unique);
  if (rows.length !== unique.length || rows.some((r) => r.status !== "ready"))
    throw new AppError("VALIDATION_ERROR", "An attachment isn't ready", { recovery: "retry" });
  const ordered = unique.map((id) => rows.find((r) => r.id === id)!);
  const result: TurnAttachments = { sent: [], documents: [], images: [] };
  for (const row of ordered) {
    const data = await downloadChatAttachment(auth.workspaceId, row.storage_path);
    if (!data)
      throw new AppError("VALIDATION_ERROR", "An attachment is missing", { recovery: "retry" });
    result.sent.push({ id: row.id, name: row.name, mimeType: row.mime_type, size: row.size_bytes });
    if (ATTACHMENT_TYPES[row.mime_type]?.kind === "image") {
      result.images.push({
        id: row.id,
        name: row.name,
        dataUrl: `data:${row.mime_type};base64,${Buffer.from(data).toString("base64")}`,
      });
      continue;
    }
    // Plain text is read as is (a short note is a fine attachment); PDF/DOCX go through the
    // document parsers, and an unreadable one (a scanned PDF) is marked as such for the model.
    const text = row.mime_type.startsWith("text/")
      ? new TextDecoder("utf-8").decode(data).trim()
      : await parseDocument({ title: row.name, mimeType: row.mime_type, data })
          .then(documentText)
          .catch(() => "");
    result.documents.push({
      id: row.id,
      name: row.name,
      text: text.slice(0, ATTACHMENT_LIMITS.maxTextChars),
      truncated: text.length > ATTACHMENT_LIMITS.maxTextChars,
    });
  }
  return result;
}

/** The attachments now belong to this turn's conversation or voice session. */
export async function markSent(auth: AuthContext, ids: string[], thread: ThreadRef) {
  if (!ids.length) return;
  const { error } = await auth.db
    .from("chat_attachments")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      conversation_id: thread.kind === "conversation" ? thread.id : null,
      session_id: thread.kind === "session" ? thread.id : null,
    })
    .eq("user_id", auth.userId)
    .eq("status", "ready")
    .in("id", ids);
  if (error) throw new AppError("INTERNAL_ERROR", "Could not attach the files", { cause: error });
}
