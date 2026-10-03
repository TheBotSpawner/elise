"use client";

import { useSyncExternalStore } from "react";

import {
  ATTACHMENT_TYPES,
  attachmentType,
  checkAttachment,
  type AttachmentKind,
  type AttachmentProblem,
  type AttachmentStatus,
} from "@/core/attachments/model";
import type { PublicError } from "@/core/errors";
import { createClient } from "@/infrastructure/supabase/client";

import {
  completeAttachmentAction,
  removeAttachmentAction,
  stageAttachmentsAction,
} from "./attachment-actions";

/**
 * The unsent draft's attachments (ADR-031). Every way in — drop anywhere on the Canvas, the
 * paperclip — adds here, and the next turn (typed or spoken) takes exactly what is shown.
 * Uploading starts at once (less waiting at send) but is not sending: staged files belong to
 * the draft until a turn takes them. One draft per tab; a reload clears it (the server expires
 * staged files nobody sent). Raw File objects never leave memory.
 */

export const CHAT_ATTACHMENTS_BUCKET_NAME = "chat-attachments";

export interface DraftAttachment {
  /** Local identity (stable across retries). */
  key: string;
  name: string;
  size: number;
  mimeType: string;
  kind: AttachmentKind;
  status: Exclude<AttachmentStatus, "removed">;
  /** Server id once staged. */
  id?: string;
  error?: PublicError;
  /** Object URL for an image thumbnail (revoked on removal). */
  preview?: string;
  file: File;
}

export interface DraftSnapshot {
  items: readonly DraftAttachment[];
  /** A send is waiting for uploads to finish. */
  waiting: boolean;
}

export interface Rejected {
  name: string;
  problem: AttachmentProblem;
}

/** The upload transport (replaced in tests). */
export interface AttachmentTransport {
  stage(file: {
    name: string;
    size: number;
  }): Promise<
    | { ok: true; id: string; path: string; token: string; contentType: string }
    | { ok: false; error: PublicError }
  >;
  put(target: { path: string; token: string; contentType: string }, file: File): Promise<boolean>;
  complete(id: string): Promise<{ ok: true } | { ok: false; error: PublicError }>;
  remove(id: string): void;
}

const UPLOAD_FAILED: PublicError = {
  code: "PROVIDER_UNAVAILABLE",
  message: "",
  retryable: true,
  recovery: "retry",
  referenceId: "",
};

export const serverTransport: AttachmentTransport = {
  async stage(file) {
    const r = await stageAttachmentsAction([file]);
    return r.ok ? { ok: true, ...r.value[0]! } : r;
  },
  async put(target, file) {
    const { error } = await createClient()
      .storage.from(CHAT_ATTACHMENTS_BUCKET_NAME)
      .uploadToSignedUrl(target.path, target.token, file, { contentType: target.contentType });
    return !error;
  },
  async complete(id) {
    const r = await completeAttachmentAction(id);
    return r.ok ? { ok: true } : r;
  },
  remove(id) {
    void removeAttachmentAction(id);
  },
};

export function createDraftStore(transport: AttachmentTransport) {
  let snapshot: DraftSnapshot = { items: [], waiting: false };
  const listeners = new Set<() => void>();
  const set = (next: Partial<DraftSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((fn) => fn());
  };
  const patch = (key: string, p: Partial<DraftAttachment>) =>
    set({ items: snapshot.items.map((a) => (a.key === key ? { ...a, ...p } : a)) });
  const find = (key: string) => snapshot.items.find((a) => a.key === key);

  async function upload(key: string) {
    const a = find(key);
    if (!a) return;
    patch(key, { status: "uploading", error: undefined });
    const fail = (error: PublicError) => {
      if (find(key)) patch(key, { status: "failed", error });
    };
    try {
      const staged = await transport.stage({ name: a.name, size: a.size });
      if (!staged.ok) return fail(staged.error);
      // Removed while staging: the staged file goes too.
      if (!find(key)) return transport.remove(staged.id);
      patch(key, { id: staged.id });
      if (!(await transport.put(staged, a.file))) return fail(UPLOAD_FAILED);
      const done = await transport.complete(staged.id);
      if (!find(key)) return transport.remove(staged.id);
      if (!done.ok) return fail(done.error);
      patch(key, { status: "ready" });
    } catch {
      fail(UPLOAD_FAILED);
    }
  }

  return {
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    get: () => snapshot,
    /** Adds files to the draft (in the order given) and starts uploading; reports the rest. */
    add(files: readonly File[]): Rejected[] {
      const rejected: Rejected[] = [];
      const added: DraftAttachment[] = [];
      for (const file of files) {
        const problem = checkAttachment(file);
        if (problem) {
          rejected.push({ name: file.name, problem });
          continue;
        }
        // The same file twice (a repeated drop event, picked again) is one attachment.
        const same = (a: DraftAttachment) =>
          a.file === file ||
          (a.name === file.name &&
            a.size === file.size &&
            a.file.lastModified === file.lastModified);
        if (snapshot.items.some(same) || added.some(same)) continue;
        const mimeType = attachmentType(file.name)!;
        const kind = ATTACHMENT_TYPES[mimeType]!.kind;
        added.push({
          key: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          mimeType,
          kind,
          status: "local",
          file,
          ...(kind === "image" && typeof URL.createObjectURL === "function"
            ? { preview: URL.createObjectURL(file) }
            : {}),
        });
      }
      if (added.length) {
        set({ items: [...snapshot.items, ...added] });
        added.forEach((a) => void upload(a.key));
      }
      return rejected;
    },
    remove(key: string) {
      const a = find(key);
      if (!a) return;
      set({ items: snapshot.items.filter((x) => x.key !== key) });
      if (a.preview) URL.revokeObjectURL(a.preview);
      // Mid-upload, the upload removes it when it lands (removing now would race the bytes).
      if (a.id && a.status !== "uploading") transport.remove(a.id);
    },
    retry(key: string) {
      if (find(key)?.status === "failed") void upload(key);
    },
    /**
     * For the turn being sent: waits for uploads, then takes every attachment (the draft is
     * cleared). null when one failed — the turn must not go without a file the user saw.
     */
    async take(): Promise<readonly DraftAttachment[] | null> {
      const busy = () =>
        snapshot.items.some((a) => a.status === "local" || a.status === "uploading");
      if (busy()) {
        set({ waiting: true });
        await new Promise<void>((resolve) => {
          const off = this.subscribe(() => {
            if (!busy()) {
              off();
              resolve();
            }
          });
        });
        set({ waiting: false });
      }
      if (snapshot.items.some((a) => a.status === "failed")) return null;
      const taken = snapshot.items;
      set({ items: [] });
      return taken;
    },
    /** The turn never reached ELISE: its attachments go back to the draft (still staged). */
    restore(items: readonly DraftAttachment[]) {
      if (items.length) set({ items: [...items, ...snapshot.items] });
    },
    /** After a sent turn: thumbnails are no longer needed. */
    release(items: readonly DraftAttachment[]) {
      items.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

/** The tab's draft. */
export const draftAttachments = createDraftStore(serverTransport);

const EMPTY: DraftSnapshot = { items: [], waiting: false };

export function useDraftAttachments(store: DraftStore = draftAttachments): DraftSnapshot {
  return useSyncExternalStore(store.subscribe, store.get, () => EMPTY);
}
