"use client";

import { MessageSquare, MoreHorizontal, Plus, Upload } from "lucide-react";
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
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
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
import { UPLOAD_ACCEPT } from "./constants";
import { AddSourceDialog, CreateSpaceDialog, type AddSourceView } from "./space-dialogs";
import { SourceIcon, SourceOptions, useRelative } from "./ui";
import { uploadFiles, uploadVersion } from "./upload";

const DOT: Record<string, string> = {
  ready: "bg-success",
  processing: "bg-accent animate-pulse",
  queued: "bg-accent animate-pulse",
  syncing: "bg-accent animate-pulse",
  needs_attention: "bg-approval",
  failed: "bg-danger",
};

const SOURCE_ORDER: SourceView["sourceType"][] = ["upload", "google_drive", "notion", "note"];
const RECENT = 8;

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
  initialAdd = null,
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
  /** Arriving from the create wizard with "Connect Google Drive / Notion" chosen. */
  initialAdd?: "drive" | "notion" | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const relative = useRelative();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState<AddSourceView | null>(initialAdd);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [creatingSub, setCreatingSub] = useState(false);
  const [showAll, setShowAll] = useState(false);
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

  const pickFiles = () => fileInput.current?.click();
  const closeAdd = () => {
    setAdding(null);
    // Drop ?add= so a refresh doesn't reopen the picker.
    if (initialAdd) window.history.replaceState(null, "", `/knowledge/spaces/${space.id}`);
  };
  const itemsOf = (type: SourceView["sourceType"]) =>
    items.filter((i) => i.sourceType === type).length;
  const ordered = [...sources].sort(
    (a, b) => SOURCE_ORDER.indexOf(a.sourceType) - SOURCE_ORDER.indexOf(b.sourceType),
  );
  const visible = showAll ? items : items.slice(0, RECENT);

  return (
    <div className="flex flex-col gap-10">
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
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[30px] leading-[1.15] font-light tracking-[-0.025em]">
            {space.name}
          </h1>
          {space.description && (
            <p className="max-w-2xl text-[15px] text-muted">{space.description}</p>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Link href={`/?space=${space.id}`} className={buttonVariants()}>
            <MessageSquare />
            {t.knowledge.ask}
          </Link>
          <Button variant="secondary" onClick={() => setAdding("choose")}>
            <Plus />
            {t.knowledge.addSource}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.knowledge.settings}
            title={t.knowledge.more}
            onClick={() => setSettingsOpen(true)}
          >
            <MoreHorizontal />
          </Button>
        </div>
        {!backgroundAvailable && (
          <p className="text-[13.5px] text-muted">{t.knowledge.background}</p>
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
                  className="flex h-9 items-center rounded-full bg-surface-2 px-4 text-[13.5px] text-muted hover:text-fg"
                >
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="flex items-center gap-2 type-label text-faint">
            {t.knowledge.sources}
            {uploading && <span className="text-accent-text">· {t.knowledge.uploading}</span>}
          </h2>
          <p className="text-[13px] text-muted">{t.knowledge.sourcesHint}</p>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            void onFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {sources.length === 0 ? (
          <div className="rounded-2xl border border-border bg-surface p-2">
            <SourceOptions
              choices={["documents", "drive", "notion"]}
              unavailable={notionAvailable ? [] : ["notion"]}
              disabled={uploading}
              onPick={(choice) =>
                choice === "documents"
                  ? pickFiles()
                  : setAdding(choice === "drive" ? "drive" : "notion")
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {ordered.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-5"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2">
                  <SourceIcon type={s.sourceType} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {s.sourceType === "upload"
                      ? t.knowledge.uploadedFiles
                      : s.sourceType === "note"
                        ? t.knowledge.sourceTypes.note
                        : s.name}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
                    {s.sourceType === "upload" || s.sourceType === "note" ? (
                      t.knowledge.itemCount(itemsOf(s.sourceType))
                    ) : (
                      <>
                        <span className="text-faint">{t.knowledge.sourceTypes[s.sourceType]}</span>
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
                  {s.sourceType === "upload" && (
                    <Button size="sm" variant="ghost" disabled={uploading} onClick={pickFiles}>
                      <Upload />
                      {t.knowledge.options.documents.title}
                    </Button>
                  )}
                  {s.sourceType === "note" && (
                    <Link
                      href="/my-elise/notes"
                      className={buttonVariants({ size: "sm", variant: "ghost" })}
                    >
                      {t.knowledge.openNotes}
                    </Link>
                  )}
                  {(s.sourceType === "google_drive" || s.sourceType === "notion") && (
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
          {t.knowledge.recent} ·{" "}
          {t.knowledge.counts(space.counts.ready, space.counts.processing, space.counts.attention)}
        </h2>
        <input
          ref={versionInput}
          type="file"
          accept={UPLOAD_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            void onFiles(e.target.files, versionFor);
            e.target.value = "";
          }}
        />
        {items.length === 0 ? (
          <p className="text-[14px] text-muted">{t.knowledge.noDocuments}</p>
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
            {visible.map((item) => {
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
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <SourceIcon type={item.sourceType} size={16} />
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
                          · {relative(item.updatedAt)}
                          {item.versions > 1 && ` · v${item.versions}`}
                        </span>
                      </p>
                    </div>
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
        {items.length > RECENT && !showAll && (
          <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowAll(true)}>
            {t.knowledge.showAll(items.length)}
          </Button>
        )}
      </section>

      <AddSourceDialog
        view={adding}
        onView={setAdding}
        onClose={closeAdd}
        onUpload={pickFiles}
        spaceId={space.id}
        accounts={accounts}
        notionAvailable={notionAvailable}
      />
      <SpaceSettingsDialog
        key={`${space.name}\n${space.description ?? ""}`}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        space={space}
        allSpaces={allSpaces}
        onNewSubspace={() => {
          setSettingsOpen(false);
          setCreatingSub(true);
        }}
      />
      <CreateSpaceDialog
        open={creatingSub}
        onClose={() => setCreatingSub(false)}
        parent={{ id: space.id, name: space.name }}
        notionAvailable={notionAvailable}
      />
    </div>
  );
}

/** Rename, describe, move, nest or archive: kept out of the way until asked for. */
function SpaceSettingsDialog({
  open,
  onClose,
  space,
  allSpaces,
  onNewSubspace,
}: {
  open: boolean;
  onClose: () => void;
  space: SpaceSummary;
  allSpaces: SpaceSummary[];
  onNewSubspace: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? "");
  // A Space cannot move under itself or its descendants.
  const descendants = new Set(withDescendants(allSpaces, [space.id]));

  function act(fn: () => Promise<KnowledgeResult<unknown>>) {
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) toast.error(t.errors.codes[r.error.code]);
      else {
        router.refresh();
        onClose();
      }
    });
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        // Closing without saving discards the edits.
        setName(space.name);
        setDescription(space.description ?? "");
        onClose();
      }}
      busy={pending}
      title={t.knowledge.settings}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          act(() => renameSpaceAction(space.id, name, description.trim() || null));
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="space-settings-name">{t.knowledge.spaceName}</Label>
          <Input
            id="space-settings-name"
            data-autofocus=""
            required
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="space-settings-description">
            {t.knowledge.description}{" "}
            <span className="font-normal text-faint">· {t.knowledge.optional}</span>
          </Label>
          <textarea
            id="space-settings-description"
            rows={2}
            value={description}
            maxLength={1000}
            placeholder={t.knowledge.descriptionPlaceholder}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-20 w-full resize-none rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-fg placeholder:text-muted/70 hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-soft focus-visible:outline-none"
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={pending || !name.trim()}>
            {t.knowledge.save}
          </Button>
        </div>
      </form>
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <Label htmlFor="space-settings-move">{t.knowledge.move}</Label>
        <Select
          id="space-settings-move"
          value=""
          disabled={pending}
          onChange={(e) => {
            const target = e.target.value;
            if (target) act(() => moveSpaceAction(space.id, target === "__top" ? null : target));
          }}
        >
          <option value="">{space.path}</option>
          <option value="__top">{t.knowledge.topLevel}</option>
          {allSpaces
            .filter((s) => !descendants.has(s.id))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.path}
              </option>
            ))}
        </Select>
      </div>
      <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
        <Button variant="ghost" onClick={onNewSubspace} disabled={pending}>
          <Plus />
          {t.knowledge.newSubspace}
        </Button>
        <Button
          variant="ghost"
          className="hover:text-danger-text"
          disabled={pending}
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
    </Dialog>
  );
}
