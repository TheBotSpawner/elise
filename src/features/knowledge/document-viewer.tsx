"use client";

import { Download, ExternalLink, FileText } from "lucide-react";
import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import type { DocumentView } from "@/application/knowledge-service";
import { buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { documentViewAction } from "./actions";

/**
 * ELISE's document viewer: a cited Knowledge document opens in place — a PDF in the browser's
 * own viewer at the cited page, an image as itself — anything else uploaded as a download, and
 * a Drive/Notion document in its own app. Every citation of a Knowledge item opens here.
 */
export interface OpenDocument {
  itemId: string;
  title?: string;
  /** The cited page (PDFs open there). */
  page?: number | null;
}

type Open = (doc: OpenDocument) => void;
const ViewerContext = createContext<Open | null>(null);

const PROVIDERS: Record<string, string> = { google_drive: "Google Drive", notion: "Notion" };

export function DocumentViewerProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const v = t.workspace.knowledge.viewer;
  const [asked, setAsked] = useState<OpenDocument | null>(null);
  const [view, setView] = useState<DocumentView | "failed" | null>(null);
  const current = useRef<string | null>(null);

  const open = useCallback<Open>((doc) => {
    current.current = doc.itemId;
    setAsked(doc);
    setView(null);
    void documentViewAction(doc.itemId).then((r) => {
      // A later opening wins: a slow answer for another document never replaces it.
      if (current.current === doc.itemId) setView(r.ok ? r.value : "failed");
    });
  }, []);
  const close = () => {
    current.current = null;
    setAsked(null);
    setView(null);
  };

  const ready = view && view !== "failed" ? view : null;
  const page = asked?.page ? `#page=${asked.page}` : "";
  const provider = ready ? PROVIDERS[ready.sourceType] : undefined;

  return (
    <ViewerContext.Provider value={open}>
      {children}
      <Dialog
        open={asked !== null}
        onClose={close}
        title={ready?.title ?? asked?.title ?? ""}
        description={ready?.space ?? undefined}
        className="sm:max-w-5xl"
      >
        <div className="flex flex-col gap-4">
          {!view ? (
            <p className="py-16 text-center text-[14px] text-muted">{v.loading}</p>
          ) : view === "failed" ? (
            <p className="py-10 text-center text-[14px] text-muted">{v.failed}</p>
          ) : view.kind === "pdf" && view.viewUrl ? (
            <iframe
              src={`${view.viewUrl}${page}`}
              title={view.title}
              className="h-[68dvh] w-full rounded-2xl border border-border bg-surface-2"
            />
          ) : view.kind === "image" && view.viewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL of the user's own file; next/image would proxy and cache it.
            <img
              src={view.viewUrl}
              alt={view.title}
              className="max-h-[68dvh] w-full rounded-2xl border border-border bg-surface-2 object-contain"
            />
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface-2 px-6 py-12 text-center">
              <span className="grid size-12 place-items-center rounded-xl bg-accent-soft text-accent-text">
                <FileText className="size-6" aria-hidden />
              </span>
              <p className="max-w-sm text-[14px] text-muted">
                {view.kind === "external" && provider
                  ? v.external(provider)
                  : view.downloadUrl
                    ? v.noPreview
                    : v.unavailable}
              </p>
            </div>
          )}
          {ready && (
            <div className="flex flex-wrap justify-end gap-2 max-sm:flex-col-reverse max-sm:[&>a]:w-full">
              <Link
                href={`/knowledge/items/${ready.itemId}`}
                onClick={close}
                className={buttonVariants({ size: "sm", variant: "ghost" })}
              >
                {v.openPage}
              </Link>
              {ready.viewUrl && (
                <a
                  href={`${ready.viewUrl}${page}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ size: "sm", variant: "secondary" })}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  {v.newTab}
                </a>
              )}
              {ready.externalUrl && provider && (
                <a
                  href={ready.externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ size: "sm" })}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                  {t.workspace.knowledge.openIn(provider)}
                </a>
              )}
              {ready.downloadUrl && (
                <a href={ready.downloadUrl} className={buttonVariants({ size: "sm" })}>
                  <Download className="size-3.5" aria-hidden />
                  {v.download}
                </a>
              )}
            </div>
          )}
        </div>
      </Dialog>
    </ViewerContext.Provider>
  );
}

/** Opens a Knowledge document in the viewer; null outside the app (no provider). */
export function useDocumentViewer(): Open | null {
  return useContext(ViewerContext);
}

/**
 * A link to a Knowledge document: a click opens the viewer (at the cited page); a new-tab click
 * (or no viewer around) goes to the document's page as before.
 */
export function DocumentLink({
  itemId,
  chunkId,
  page,
  title,
  className,
  children,
}: OpenDocument & { chunkId?: string | null; className?: string; children: ReactNode }) {
  const open = useDocumentViewer();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!open || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open({ itemId, page, title });
  };
  return (
    <a
      href={`/knowledge/items/${itemId}${chunkId ? `?chunk=${chunkId}` : ""}`}
      onClick={onClick}
      className={cn(className)}
    >
      {children}
    </a>
  );
}
