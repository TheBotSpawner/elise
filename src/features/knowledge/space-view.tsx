"use client";

import { MessageSquare, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import type {
  ItemView,
  KnowledgeAccount,
  SourceView,
  SpaceSummary,
} from "@/application/knowledge-service";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { withDescendants } from "@/core/knowledge/model";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  archiveSpaceAction,
  deleteItemAction,
  moveSpaceAction,
  removeSourceAction,
  renameSpaceAction,
  retryItemAction,
  syncNowAction,
  type KnowledgeResult,
} from "./actions";
import { MAX_UPLOAD_MB, UPLOAD_ACCEPT } from "./constants";
import { NewSpaceForm } from "./knowledge-home";
import { DrivePicker, NotionPicker } from "./source-pickers";
import { uploadFiles, uploadVersion } from "./upload";

function useRelative() {
  const { locale } = useI18n();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return (iso: string) => {
    const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
    return rtf.format(Math.round(hours / 24), "day");
  };
}

const DOT: Record<string, string> = {
  ready: "bg-success",
  processing: "bg-accent animate-pulse",
  queued: "bg-accent animate-pulse",
  syncing: "bg-accent animate-pulse",
  needs_attention: "bg-approval",
  failed: "bg-danger",
};

export function SpaceView({
  space,
  subspaces,
  sources,
  items,
  accounts,
  allSpaces,
  workspaceId,
  notionAvailable,
  backgroundAvailable,
}: {
  space: SpaceSummary;
  subspaces: SpaceSummary[];
  sources: SourceView[];
  items: ItemView[];
  accounts: KnowledgeAccount[];
  allSpaces: SpaceSummary[];
  workspaceId: string;
  notionAvailable: boolean;
  backgroundAvailable: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const relative = useRelative();
  const [pending, startTransition] = useTransition();
  const [panel, setPanel] = useState<"drive" | "notion" | "subspace" | "rename" | null>(null);
  const [name, setName] = useState(space.name);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const [versionFor, setVersionFor] = useState<string | null>(null);
  useRealtimeRefresh(workspaceId, ["knowledge_items", "knowledge_sources", "knowledge_sync_runs"]);

  function act<T>(fn: () => Promise<KnowledgeResult<T>>, success?: string) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) toast.error(t.errors.codes[r.error.code]);
      else {
        if (success) toast.success(success);
        router.refresh();
      }
    });
  }

  async function onFiles(files: FileList | null, itemId?: string | null) {
    if (!files?.length) return;
    setUploading(true);
    const r = itemId
      ? await uploadVersion(itemId, files[0]!)
      : await uploadFiles(space.id, [...files]);
    setUploading(false);
    if (!r.ok) toast.error(r.error.message || t.errors.codes[r.error.code]);
    else toast.success(t.knowledge.uploaded(r.value));
    router.refresh();
  }

  // A Space cannot move under itself or its descendants.
  const descendants = new Set(withDescendants(allSpaces, [space.id]));

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <nav className="text-[13px] text-muted">
          <Link href="/knowledge" className="hover:text-fg">
            {t.knowledge.title}
          </Link>
          {space.path
            .split(" › ")
            .slice(0, -1)
            .map((p) => ` › ${p}`)}
        </nav>
        {panel === "rename" ? (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => renameSpaceAction(space.id, name));
              setPanel(null);
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="max-w-sm"
              autoFocus
            />
            <Button type="submit">{t.knowledge.save}</Button>
          </form>
        ) : (
          <h1 className="text-[30px] leading-[1.15] font-light tracking-[-0.025em]">
            {space.name}
          </h1>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Link href={`/?space=${space.id}`} className={buttonVariants({ size: "sm" })}>
            <MessageSquare />
            {t.knowledge.ask}
          </Link>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPanel(panel === "subspace" ? null : "subspace")}
          >
            {t.knowledge.newSubspace}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPanel(panel === "rename" ? null : "rename")}
          >
            {t.knowledge.rename}
          </Button>
          <Select
            aria-label={t.knowledge.move}
            value=""
            className="h-8 w-auto text-[13px]"
            onChange={(e) => {
              const target = e.target.value;
              if (target) act(() => moveSpaceAction(space.id, target === "__top" ? null : target));
            }}
          >
            <option value="">{t.knowledge.move}</option>
            <option value="__top">{t.knowledge.topLevel}</option>
            {allSpaces
              .filter((s) => !descendants.has(s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.path}
                </option>
              ))}
          </Select>
          <Button
            size="sm"
            variant="ghost"
            className="hover:text-danger-text"
            onClick={() => {
              if (!window.confirm(t.knowledge.archiveConfirm(space.name))) return;
              startTransition(async () => {
                const r = await archiveSpaceAction(space.id);
                if (r.ok) router.push("/knowledge");
                else toast.error(t.errors.codes[r.error.code]);
              });
            }}
          >
            {t.knowledge.archive}
          </Button>
        </div>
        {panel === "subspace" && (
          <NewSpaceForm
            parentId={space.id}
            onDone={(id) => router.push(`/knowledge/spaces/${id}`)}
          />
        )}
      </header>

      {subspaces.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="type-label text-faint">{t.knowledge.spaces}</h2>
          <ul className="flex flex-wrap gap-1.5">
            {subspaces.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/knowledge/spaces/${c.id}`}
                  className="flex h-9 items-center rounded-full border border-border px-4 text-[13.5px] hover:border-accent-line"
                >
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">{t.knowledge.sources}</h2>
        {!backgroundAvailable && (
          <p className="text-[13.5px] text-muted">{t.knowledge.background}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            onChange={(e) => {
              void onFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            variant="secondary"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
          >
            <Upload />
            {uploading ? t.knowledge.uploading : t.knowledge.upload}
          </Button>
          <Button variant="secondary" onClick={() => setPanel(panel === "drive" ? null : "drive")}>
            {t.knowledge.connectDrive}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setPanel(panel === "notion" ? null : "notion")}
          >
            {t.knowledge.connectNotion}
          </Button>
        </div>
        <p className="text-[12.5px] text-faint">{t.knowledge.uploadHint(MAX_UPLOAD_MB)}</p>
        {panel === "drive" && (
          <DrivePicker
            spaceId={space.id}
            accounts={accounts}
            onDone={() => (setPanel(null), router.refresh())}
          />
        )}
        {panel === "notion" && (
          <NotionPicker
            spaceId={space.id}
            accounts={accounts}
            notionAvailable={notionAvailable}
            onDone={() => (setPanel(null), router.refresh())}
          />
        )}
        {sources.length > 0 && (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {sources.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {s.sourceType === "upload" ? t.knowledge.sourceTypes.upload : s.name}
                  </p>
                  <p className="flex items-center gap-2 text-[12.5px] text-muted">
                    <span className="text-faint">{t.knowledge.sourceTypes[s.sourceType]}</span>
                    {s.sourceType !== "upload" && (
                      <>
                        <span
                          aria-hidden
                          className={cn("size-1.5 rounded-full", DOT[s.status] ?? "bg-faint")}
                        />
                        {t.knowledge.sourceStatus[s.status]}
                        {s.lastSyncedAt && ` · ${t.knowledge.lastSynced(relative(s.lastSyncedAt))}`}
                      </>
                    )}
                  </p>
                </div>
                <div className="flex gap-1">
                  {s.sourceType !== "upload" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending || s.status === "syncing"}
                      onClick={() => act(() => syncNowAction(s.id), t.knowledge.syncing)}
                    >
                      {t.knowledge.syncNow}
                    </Button>
                  )}
                  {s.status === "needs_attention" && (
                    <Link
                      href="/connections"
                      className={buttonVariants({ size: "sm", variant: "ghost" })}
                    >
                      {t.brief.reconnect}
                    </Link>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="hover:text-danger-text"
                    disabled={pending}
                    onClick={() => {
                      if (window.confirm(t.knowledge.removeSourceConfirm))
                        act(() => removeSourceAction(s.id));
                    }}
                  >
                    {t.knowledge.removeSource}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="type-label text-faint">
          {t.knowledge.documents} ·{" "}
          {t.knowledge.counts(space.counts.ready, space.counts.processing, space.counts.attention)}
        </h2>
        <input
          ref={versionInput}
          type="file"
          accept={UPLOAD_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            void onFiles(e.target.files, versionFor);
            e.target.value = "";
          }}
        />
        {items.length === 0 ? (
          <p className="text-[14px] text-muted">{t.knowledge.noDocuments}</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {items.map((item) => {
              const detail =
                item.status === "queued" || item.status === "processing"
                  ? (t.knowledge.detail[item.statusDetail as keyof typeof t.knowledge.detail] ??
                    t.knowledge.status[item.status])
                  : t.knowledge.status[item.status];
              const attention =
                item.status === "failed" ||
                item.status === "needs_attention" ||
                (item.status === "ready" && item.errorCode);
              return (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/knowledge/items/${item.id}`}
                      className="block truncate text-sm hover:text-accent-text"
                    >
                      {item.title}
                    </Link>
                    <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                      <span
                        aria-hidden
                        className={cn("size-1.5 rounded-full", DOT[item.status] ?? "bg-faint")}
                      />
                      {detail}
                      {attention && item.statusDetail && (
                        <span className="text-approval-text">· {item.statusDetail}</span>
                      )}
                      <span className="text-faint">
                        · {t.knowledge.sourceTypes[item.sourceType]}
                        {item.versions > 1 && ` · v${item.versions}`}
                      </span>
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {attention && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => act(() => retryItemAction(item.id))}
                      >
                        {t.knowledge.retry}
                      </Button>
                    )}
                    {item.sourceType === "upload" && item.status !== "processing" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={uploading}
                        onClick={() => {
                          setVersionFor(item.id);
                          versionInput.current?.click();
                        }}
                      >
                        {t.knowledge.newVersion}
                      </Button>
                    )}
                    {item.sourceType === "upload" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="hover:text-danger-text"
                        disabled={pending}
                        onClick={() => {
                          if (window.confirm(t.knowledge.deleteConfirm))
                            act(() => deleteItemAction(item.id));
                        }}
                      >
                        {t.knowledge.delete}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
