import "server-only";

import { ATTACHMENT_TYPES } from "@/core/attachments/model";
import { AppError } from "@/core/errors";
import type { KnowledgeManager, SpaceOverview } from "@/core/knowledge/admin";
import { downloadChatAttachment } from "@/infrastructure/supabase/storage";

import type { AuthContext } from "./auth-context";
import {
  archiveSpace,
  createSpace,
  deleteItem,
  getSpace,
  listSpaces,
  removeSource,
  retryItem,
  saveFileToKnowledge,
  syncNow,
  updateSpace,
  updateSpaceContext,
  type SpaceSummary,
} from "./knowledge-service";
import { createSection, moveItem } from "./sections-service";

/**
 * ELISE's Knowledge administration (ADR-035): the KnowledgeManager port over the same services
 * the Knowledge UI uses — same ownership checks, validation, audit events and Realtime — so a
 * change made by voice or chat is exactly a change made by hand.
 */
export function knowledgeManager(auth: AuthContext): KnowledgeManager {
  const overview = (s: SpaceSummary, all: SpaceSummary[]): SpaceOverview => ({
    id: s.id,
    name: s.name,
    path: s.path,
    parentId: s.parentId,
    description: s.description,
    context: s.context,
    sections: all.filter((c) => c.parentId === s.id).length,
    sources: s.sourceCount,
    documents: s.counts,
  });

  return {
    async listSpaces() {
      const all = await listSpaces(auth);
      return all.map((s) => overview(s, all));
    },

    async contents(spaceId) {
      const [view, all] = await Promise.all([getSpace(auth, spaceId), listSpaces(auth)]);
      const parent = view.space.parentId ? all.find((s) => s.id === view.space.parentId) : null;
      return {
        space: overview(view.space as SpaceSummary, all),
        parent: parent
          ? { name: parent.name, description: parent.description, context: parent.context }
          : null,
        sections: view.children.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
        })),
        sources: view.sources
          .filter((s) => s.sourceType !== "upload" && s.sourceType !== "note")
          .map((s) => ({
            id: s.id,
            name: s.name,
            type: s.sourceType,
            status: s.state,
            documents: s.counts,
            lastSyncedAt: s.lastSyncedAt,
            lastError: s.lastErrorCode,
          })),
        documents: view.items.map((i) => ({
          id: i.id,
          title: i.title,
          type: i.sourceType,
          status: i.status,
          detail: i.status === "ready" ? null : (i.statusDetail ?? i.errorCode ?? null),
        })),
      };
    },

    async createSpace(input) {
      if (input.parentId) {
        const { id } = await createSection(auth, {
          parentId: input.parentId,
          name: input.name,
          description: input.description ?? null,
        });
        return { id, section: true };
      }
      const id = await createSpace(auth, {
        name: input.name,
        description: input.description ?? null,
      });
      return { id, section: false };
    },

    async updateSpace(spaceId, patch) {
      const { context, ...rest } = patch;
      if (Object.keys(rest).length) await updateSpace(auth, spaceId, rest);
      if (context !== undefined) await updateSpaceContext(auth, spaceId, context);
    },

    archiveSpace: (spaceId) => archiveSpace(auth, spaceId).then(() => undefined),
    moveDocument: (itemId, spaceId) => moveItem(auth, itemId, spaceId).then(() => undefined),
    removeDocument: (itemId) => deleteItem(auth, itemId).then(() => undefined),
    removeSource: (sourceId) => removeSource(auth, sourceId),

    async retryDocuments(itemIds) {
      let queued = 0;
      for (const id of itemIds) {
        await retryItem(auth, id);
        queued++;
      }
      return queued;
    },

    syncSource: async (sourceId) => (await syncNow(auth, sourceId)).status,

    async saveAttachment(attachmentId, spaceId) {
      // Only the author's own attachments, already part of a turn or ready in the draft.
      const { data: row } = await auth.db
        .from("chat_attachments")
        .select("id, name, mime_type, storage_path, status, conversation_id, session_id")
        .eq("id", attachmentId)
        .eq("workspace_id", auth.workspaceId)
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (!row || row.status === "uploading")
        throw new AppError("NOT_FOUND", "That attachment isn't available", { recovery: "review" });
      if (!ATTACHMENT_TYPES[row.mime_type])
        throw new AppError("VALIDATION_ERROR", "That file type can't be saved to Knowledge");
      const bytes = await downloadChatAttachment(auth.workspaceId, row.storage_path);
      if (!bytes) throw new AppError("NOT_FOUND", "The attachment's file is missing");
      const { itemId } = await saveFileToKnowledge(auth, spaceId, {
        name: row.name,
        mimeType: row.mime_type,
        bytes,
        origin: {
          chatAttachment: {
            id: row.id,
            conversationId: row.conversation_id,
            sessionId: row.session_id,
          },
        },
      });
      return { itemId, title: row.name };
    },
  };
}
