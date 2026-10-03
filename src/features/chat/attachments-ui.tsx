"use client";

import { FileText, LoaderCircle, Paperclip, RotateCw, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ATTACHMENT_LIMITS, type SentAttachment } from "@/core/attachments/model";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  draftAttachments,
  useDraftAttachments,
  type DraftStore,
  type Rejected,
} from "./draft-attachments";

/** Drop and picker both land here: one draft, one pipeline (ADR-031). */
export function useAddFiles(store: DraftStore = draftAttachments) {
  const { t } = useI18n();
  return (files: readonly File[]) => {
    const rejected = store.add(files);
    rejected.forEach((r) => toast.error(rejectionText(t, r)));
  };
}

function rejectionText(t: ReturnType<typeof useI18n>["t"], r: Rejected) {
  return r.problem === "unsupported"
    ? t.attachments.unsupported(r.name)
    : r.problem === "empty"
      ? t.attachments.empty(r.name)
      : t.attachments.tooLarge(
          r.name,
          Math.round(
            (/\.(png|jpe?g|webp|gif)$/i.test(r.name)
              ? ATTACHMENT_LIMITS.maxImageBytes
              : ATTACHMENT_LIMITS.maxBytes) /
              1024 /
              1024,
          ),
        );
}

// ── Global drop target ──────────────────────────────────────────────────────

/** Only an external file drag counts (not text selections or ELISE's own drags). */
export function isFileDrag(types: Iterable<string> | null | undefined): boolean {
  return Boolean(types) && Array.from(types!).includes("Files");
}

/**
 * Drag enter/leave fire for every child the cursor crosses: a depth count keeps one stable
 * "dragging" state for the whole drag (no flicker over the Orb, Surfaces or the dock).
 */
export function createDragDepth(onChange: (active: boolean) => void) {
  let depth = 0;
  return {
    enter() {
      if (depth++ === 0) onChange(true);
    },
    leave() {
      if (depth > 0 && --depth === 0) onChange(false);
    },
    reset() {
      if (depth === 0) return;
      depth = 0;
      onChange(false);
    },
  };
}

/** The whole window accepts dropped files while ELISE's interaction is on screen. */
export function FileDropZone() {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const add = useAddFiles();
  const [active, setActive] = useState(false);
  useEffect(() => {
    const depth = createDragDepth(setActive);
    const enter = (e: DragEvent) => {
      if (isFileDrag(e.dataTransfer?.types)) depth.enter();
    };
    const leave = (e: DragEvent) => {
      if (isFileDrag(e.dataTransfer?.types)) depth.leave();
    };
    const over = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer?.types)) return;
      e.preventDefault(); // allows the drop (and keeps the browser from opening the file)
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!isFileDrag(e.dataTransfer?.types)) return;
      e.preventDefault();
      depth.reset();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) add(files);
    };
    const cancel = () => depth.reset();
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    window.addEventListener("dragend", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
      window.removeEventListener("dragend", cancel);
      window.removeEventListener("blur", cancel);
    };
    // `add` only closes over the dictionary; listeners are installed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="drop"
          role="status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduced ? 0 : 0.14 }}
          className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-[color-mix(in_oklab,var(--bg)_55%,transparent)] p-3"
        >
          <div className="absolute inset-3 rounded-[28px] border-2 border-dashed border-accent-line shadow-[0_0_48px_-12px_var(--accent)]" />
          <div className="flex flex-col items-center gap-2 rounded-[24px] border border-border-strong bg-[var(--dock-bg)] px-7 py-5 text-center shadow-[var(--dock-shadow)] backdrop-blur-xl">
            <Paperclip className="size-5 text-accent-text" aria-hidden />
            <p className="text-[16px] font-medium">{t.attachments.drop}</p>
            <p className="text-[12.5px] text-muted">{t.attachments.dropHint}</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Chips ────────────────────────────────────────────────────────────────────

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const ext = (name: string) => name.split(".").pop()?.toUpperCase().slice(0, 4) ?? "";

/** The draft's files, next to the composer: thumbnail or type, name, state, remove / retry. */
export function DraftAttachmentChips({ store = draftAttachments }: { store?: DraftStore }) {
  const { t } = useI18n();
  const { items, waiting } = useDraftAttachments(store);
  if (!items.length) return null;
  return (
    <div className="pointer-events-auto flex w-full max-w-[760px] flex-col items-center gap-1.5">
      <ul aria-label={t.attachments.label} className="flex flex-wrap justify-center gap-1.5">
        {items.map((a) => (
          <li
            key={a.key}
            className={cn(
              "flex h-11 max-w-[260px] items-center gap-2 rounded-2xl border bg-[var(--dock-bg)] pr-1 pl-1.5 backdrop-blur-xl",
              a.status === "failed" ? "border-approval-line" : "border-border",
            )}
          >
            {a.preview ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local object URL
              <img src={a.preview} alt="" className="size-8 rounded-lg object-cover" />
            ) : (
              <span className="grid size-8 place-items-center rounded-lg bg-surface-2 text-muted">
                <FileText className="size-4" aria-hidden />
              </span>
            )}
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[12.5px]">{a.name}</span>
              <span
                className={cn(
                  "font-mono text-[10px] tracking-[0.06em]",
                  a.status === "failed" ? "text-approval-text" : "text-faint",
                )}
              >
                {a.status === "failed"
                  ? t.attachments.failed
                  : a.status === "ready"
                    ? `${ext(a.name)} · ${size(a.size)}`
                    : t.attachments.uploading}
              </span>
            </span>
            {(a.status === "uploading" || a.status === "local") && (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted" aria-hidden />
            )}
            {a.status === "failed" && (
              <button
                type="button"
                onClick={() => store.retry(a.key)}
                aria-label={t.attachments.retry(a.name)}
                title={t.attachments.retry(a.name)}
                className="grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-active hover:text-fg"
              >
                <RotateCw className="size-3.5" aria-hidden />
              </button>
            )}
            <button
              type="button"
              onClick={() => store.remove(a.key)}
              aria-label={t.attachments.remove(a.name)}
              title={t.attachments.remove(a.name)}
              className="grid size-7 shrink-0 place-items-center rounded-full text-muted hover:bg-active hover:text-fg"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {waiting && (
        <p role="status" className="font-mono text-[10.5px] tracking-[0.06em] text-muted">
          {t.attachments.waiting}
        </p>
      )}
    </div>
  );
}

/** A sent turn's files, compact, in the transcript. */
export function SentAttachments({ files }: { files: readonly SentAttachment[] }) {
  const { t } = useI18n();
  return (
    <ul aria-label={t.attachments.sent} className="mt-1.5 flex flex-wrap justify-end gap-1">
      {files.map((f) => (
        <li
          key={f.id}
          className="flex max-w-[220px] items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11.5px] text-fg2"
        >
          <Paperclip className="size-3 shrink-0 text-muted" aria-hidden />
          <span className="truncate">{f.name}</span>
        </li>
      ))}
    </ul>
  );
}
