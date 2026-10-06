"use client";

import {
  FolderInput,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import type {
  ItemView,
  KnowledgeAccount,
  SourceView,
  SpaceSummary,
} from "@/application/knowledge-service";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/input";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  archiveSpaceAction,
  deleteItemAction,
  moveItemAction,
  removeSourceAction,
  retryItemAction,
  syncNowAction,
  type KnowledgeResult,
} from "./actions";
import { SpaceGlyph } from "./appearance";
import {
  SourceAttentionDialog,
  SpaceAttentionDialog,
  useSourceKind,
  useSourceName,
} from "./attention-dialog";
import { UPLOAD_ACCEPT } from "./constants";
import { SectionDialog } from "./section-dialog";
import { SourceMenu } from "./source-menu";
import { SpaceContext } from "./space-context";
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

const STATE_DOT: Record<SourceView["state"], string> = {
  preparing: "bg-accent animate-pulse",
  retrying: "bg-approval animate-pulse",
  syncing: "bg-accent animate-pulse",
  up_to_date: "bg-success",
  needs_attention: "bg-approval",
  available: "bg-success",
};

const SOURCE_ORDER: SourceView["sourceType"][] = ["upload", "google_drive", "notion", "note"];
const RECENT = 8;

export type SectionCard = SpaceSummary;

export function SpaceView({
  space,
  sections,
  sources,
  items,
  accounts,
  allSpaces,
  workspaceId,
  notionAvailable,
  backgroundAvailable,
  initialAdd = null,
  initialAttention = false,
  conversations = [],
  methods = null,
}: {
  /** This Space's Methods (ADR-040): how ELISE works here. */
  methods?: ReactNode;
  /** Conversations linked to this Space (its Sections included) or Section (ADR-020). */
  conversations?: {
    key: string;
    href: string;
    title: string;
    at: string;
    section: string | null;
  }[];
  space: SpaceSummary;
  /** A Space's Sections (ADR-018); always empty inside a Section (one level). */
  sections: SectionCard[];
  sources: SourceView[];
  items: ItemView[];
  accounts: KnowledgeAccount[];
  allSpaces: SpaceSummary[];
  workspaceId: string;
  notionAvailable: boolean;
  backgroundAvailable: boolean;
  /** Arriving from the create wizard with "Connect Google Drive / Notion" chosen. */
  initialAdd?: "drive" | "notion" | null;
  /** Arriving from a card's "N need attention" (?attention=1). */
  initialAttention?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const relative = useRelative();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState<AddSourceView | null>(initialAdd);
  const [spaceAttention, setSpaceAttention] = useState(initialAttention);
  // Kept by id so the dialog follows the live source after a refresh.
  const [inspecting, setInspecting] = useState<string | null>(null);
  const nameOf = useSourceName();
  const kindOf = useSourceKind();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingSpace, setEditingSpace] = useState(false);
  const [creatingSection, setCreatingSection] = useState(false);
  const [moving, setMoving] = useState<ItemView | null>(null);
  const isSection = Boolean(space.parentId);
  const parent = isSection ? allSpaces.find((s) => s.id === space.parentId) : undefined;
  // Where an uploaded document can go: within this Space and its Sections, never elsewhere.
  const moveTargets = isSection
    ? allSpaces.filter(
        (s) => s.id === space.parentId || (s.parentId === space.parentId && s.id !== space.id),
      )
    : allSpaces.filter((s) => s.parentId === space.id);
  const [showAll, setShowAll] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const versionInput = useRef<HTMLInputElement>(null);
  const [versionFor, setVersionFor] = useState<string | null>(null);
  useRealtimeRefresh(workspaceId, ["knowledge_items", "knowledge_sources", "knowledge_sync_runs"]);
  // While work is in flight, look again now and then: a job the runtime never picks up writes
  // nothing (no Realtime event), and each look runs the watchdog, so "stalled" shows on time.
  const working =
    sources.some((s) => s.phase !== null && s.state !== "needs_attention") ||
    items.some((i) => i.status === "queued" || i.status === "processing");
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => router.refresh(), 20_000);
    return () => clearInterval(timer);
  }, [working, router]);

  /** Sync now / Retry: an active sync is the answer, not an error. */
  function syncSource(sourceId: string) {
    startTransition(async () => {
      const r = await syncNowAction(sourceId);
      if (!r.ok) return void toast.error(errorText(t, r.error));
      if (r.value.status === "already_syncing") toast(t.knowledge.alreadySyncing);
      else if (r.value.status === "started") toast.success(t.knowledge.syncing);
      router.refresh();
    });
  }

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
    if (!r.ok) toast.error(errorText(t, r.error));
    else toast.success(t.knowledge.uploaded(r.value));
    router.refresh();
  }

  const pickFiles = () => fileInput.current?.click();
  const closeAdd = () => {
    setAdding(null);
    // Drop ?add= so a refresh doesn't reopen the picker.
    if (initialAdd) window.history.replaceState(null, "", `/knowledge/spaces/${space.id}`);
  };
  const ordered = [...sources].sort(
    (a, b) => SOURCE_ORDER.indexOf(a.sourceType) - SOURCE_ORDER.indexOf(b.sourceType),
  );
  const visible = showAll ? items : items.slice(0, RECENT);

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-col gap-3">
        <nav aria-label={t.knowledge.breadcrumb} className="text-[13px] text-muted">
          <Link href="/knowledge" className="hover:text-fg">
            {t.knowledge.title}
          </Link>
          {parent && (
            <>
              {" › "}
              <Link href={`/knowledge/spaces/${parent.id}`} className="hover:text-fg">
                {parent.name}
              </Link>
            </>
          )}
        </nav>
        <div className="flex flex-col gap-1.5">
          <h1 className="flex items-center gap-3 text-[30px] leading-[1.15] font-light tracking-[-0.025em]">
            <SpaceGlyph icon={space.icon} color={space.color} size="lg" />
            {space.name}
          </h1>
          {space.description && (
            <p className="max-w-2xl text-[15px] text-muted">{space.description}</p>
          )}
          {/* A new General Knowledge says what it's for — nothing invented, no warnings. */}
          {space.general && sources.length === 0 && sections.length === 0 && !space.context && (
            <p className="max-w-2xl text-[13.5px] text-faint">{t.knowledge.generalIntro}</p>
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
          {!isSection && (
            <Button variant="secondary" onClick={() => setCreatingSection(true)}>
              <Plus />
              {t.knowledge.sections.new}
            </Button>
          )}
          <Button variant="ghost" onClick={() => setEditingSpace(true)}>
            <Pencil />
            {isSection ? t.knowledge.editSection : t.knowledge.editSpace}
          </Button>
          {/* General Knowledge can't be archived (ADR-047): its only setting isn't offered. */}
          {!space.general && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.knowledge.settings}
              title={t.knowledge.more}
              onClick={() => setSettingsOpen(true)}
            >
              <MoreHorizontal />
            </Button>
          )}
        </div>
        {!backgroundAvailable && (
          <p className="text-[13.5px] text-muted">{t.knowledge.background}</p>
        )}
      </header>

      <SpaceContext
        key={space.id}
        spaceId={space.id}
        initial={space.context}
        isSection={isSection}
      />

      {methods}

      {!isSection && (
        <section className="flex flex-col gap-3">
          <h2 className="type-label text-faint">{t.knowledge.sections.title}</h2>
          {sections.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border p-5">
              <p className="flex items-center gap-2 text-[14px] text-muted">
                <LayoutGrid className="size-4 shrink-0 text-faint" aria-hidden />
                {t.knowledge.sections.empty}
              </p>
              <Button size="sm" variant="secondary" onClick={() => setCreatingSection(true)}>
                <Plus />
                {t.knowledge.sections.createFirst}
              </Button>
            </div>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {sections.map((c) => (
                <li
                  key={c.id}
                  className="relative flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 transition-colors hover:border-accent/50"
                >
                  <SpaceGlyph icon={c.icon} color={c.color} />
                  <span className="min-w-0 flex-1">
                    <Link
                      href={`/knowledge/spaces/${c.id}`}
                      className="block truncate text-[14.5px] font-medium after:absolute after:inset-0 after:rounded-2xl"
                    >
                      {c.name}
                    </Link>
                    <span className="block truncate text-[12.5px] text-muted">
                      {t.knowledge.sourceSummary(c.sources.total, c.sources.processing, 0)}
                      {c.sources.attention > 0 && (
                        <>
                          {" · "}
                          <Link
                            href={`/knowledge/spaces/${c.id}?attention=1`}
                            className="relative z-10 text-approval-text underline-offset-2 hover:underline"
                          >
                            {t.knowledge.attentionCount(c.sources.attention)}
                          </Link>
                        </>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 type-label text-faint">
              {isSection ? t.knowledge.sources : t.knowledge.sections.generalSources}
              {sources.length > 0 && (
                <span>· {t.knowledge.sourceSummary(space.sources.total, 0, 0)}</span>
              )}
              {uploading && <span className="text-accent-text">· {t.knowledge.uploading}</span>}
            </h2>
            {/* Where sources are listed, adding one is right there too (same flow as the header). */}
            {sources.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setAdding("choose")}>
                <Plus />
                {t.knowledge.addSource}
              </Button>
            )}
          </div>
          <p className="text-[13px] text-muted">
            {isSection
              ? t.knowledge.sections.sectionSourcesHint(parent?.name ?? "")
              : sections.length
                ? t.knowledge.sections.generalSourcesHint
                : t.knowledge.sourcesHint}
          </p>
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
                  <p className="truncate text-sm font-medium">{nameOf(s)}</p>
                  <p className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-muted">
                    {s.sourceType === "upload" || s.sourceType === "note" ? (
                      <>
                        {t.knowledge.documentCount(
                          s.counts.ready + s.counts.processing + s.counts.attention,
                        )}
                        {s.counts.attention > 0 && (
                          <button
                            type="button"
                            onClick={() => setInspecting(s.id)}
                            className="text-approval-text underline-offset-2 hover:underline"
                          >
                            · {t.knowledge.attentionCount(s.counts.attention)}
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="text-faint">{kindOf(s)}</span>
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 rounded-full",
                            s.rollup === "needs_attention" || s.rollup === "failed"
                              ? "bg-approval"
                              : STATE_DOT[s.state],
                          )}
                        />
                        {s.rollup === "needs_attention" || s.rollup === "failed" ? (
                          <button
                            type="button"
                            onClick={() => setInspecting(s.id)}
                            title={t.knowledge.attention.inspect}
                            className="text-approval-text underline-offset-2 hover:underline"
                          >
                            {t.knowledge.rollup[s.rollup]}
                            {s.counts.attention > 0 &&
                              ` · ${t.knowledge.attentionCount(s.counts.attention)}`}
                          </button>
                        ) : s.state === "available" ? (
                          // Read live when needed (ADR-046): no indexing to report.
                          <span title={t.knowledge.liveHint}>
                            {t.knowledge.sourceState.available}
                            {s.lastSyncedAt &&
                              ` · ${t.knowledge.checked(relative(s.lastSyncedAt))}`}
                          </span>
                        ) : s.state === "up_to_date" && s.lastSyncedAt ? (
                          t.knowledge.upToDate(relative(s.lastSyncedAt))
                        ) : (
                          t.knowledge.sourceState[s.state]
                        )}
                        {/* What it is doing right now: queued, discovering, extracting… */}
                        {s.phase &&
                          s.state !== "needs_attention" &&
                          s.state !== "up_to_date" &&
                          ` · ${t.knowledge.sourcePhase[s.phase]}`}
                        {/* Partial readiness: what is ready is already usable. */}
                        {s.state === "preparing" &&
                          s.counts.ready + s.counts.processing > 0 &&
                          ` · ${t.knowledge.readyOf(s.counts.ready, s.counts.ready + s.counts.processing)}`}
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
                  {s.state === "needs_attention" &&
                    (["AUTH_EXPIRED", "AUTH_ERROR", "PERMISSION_DENIED"].includes(
                      s.lastErrorCode ?? "",
                    ) ? (
                      <Link
                        href="/connections"
                        className={buttonVariants({ size: "sm", variant: "ghost" })}
                      >
                        {t.brief.reconnect}
                      </Link>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => syncSource(s.id)}
                      >
                        {t.knowledge.sourceDetails.retry}
                      </Button>
                    ))}
                  <SourceMenu
                    source={s}
                    disabled={pending}
                    when={relative}
                    onSyncNow={() => syncSource(s.id)}
                    onRemove={() => {
                      if (window.confirm(t.knowledge.removeSourceConfirm))
                        act(() => removeSourceAction(s.id));
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {conversations.length > 0 && (
        <section className="flex flex-col gap-2 border-t border-border pt-6">
          <h2 className="type-label text-faint">
            {isSection ? t.history.related : t.history.recent}
          </h2>
          <ul className="flex flex-col">
            {conversations.map((c) => (
              <li key={c.key}>
                <Link
                  href={c.href}
                  className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-[14px] hover:bg-active"
                >
                  <span className="min-w-0 truncate">
                    {c.section && <span className="text-muted">{c.section} · </span>}
                    {c.title || t.chat.untitled}
                  </span>
                  <span className="shrink-0 text-[12.5px] text-faint">{relative(c.at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3 border-t border-border pt-6">
        <h2 className="type-label text-faint">{t.knowledge.recent}</h2>
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
                    {item.sourceType === "upload" && moveTargets.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => setMoving(item)}
                      >
                        <FolderInput />
                        {t.knowledge.sections.move}
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

      <MoveItemDialog
        item={moving}
        targets={moveTargets}
        onClose={() => setMoving(null)}
        onMoved={() => {
          setMoving(null);
          router.refresh();
        }}
      />
      {!isSection && (
        <SectionDialog
          open={creatingSection}
          onClose={() => setCreatingSection(false)}
          parent={{ id: space.id, name: space.name, color: space.color }}
        />
      )}
      <AddSourceDialog
        view={adding}
        onView={setAdding}
        onClose={closeAdd}
        onUpload={pickFiles}
        spaceId={space.id}
        destination={space.path}
        accounts={accounts}
        notionAvailable={notionAvailable}
      />
      <SpaceAttentionDialog
        open={spaceAttention}
        sources={sources}
        onClose={() => {
          setSpaceAttention(false);
          if (initialAttention)
            window.history.replaceState(null, "", `/knowledge/spaces/${space.id}`);
        }}
        onPick={(s) => {
          setSpaceAttention(false);
          setInspecting(s.id);
        }}
      />
      <SourceAttentionDialog
        source={sources.find((s) => s.id === inspecting) ?? null}
        onClose={() => setInspecting(null)}
        onSync={(id) => syncSource(id)}
        onRemove={(id) => {
          if (!window.confirm(t.knowledge.removeSourceConfirm)) return;
          setInspecting(null);
          act(() => removeSourceAction(id));
        }}
      />
      <CreateSpaceDialog
        open={editingSpace}
        onClose={() => setEditingSpace(false)}
        space={space}
        allSpaces={allSpaces}
        notionAvailable={notionAvailable}
      />
      <SpaceSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        space={space}
      />
    </div>
  );
}

/** Archive, kept out of the way until asked for (Sections are created from the page). */
function SpaceSettingsDialog({
  open,
  onClose,
  space,
}: {
  open: boolean;
  onClose: () => void;
  space: SpaceSummary;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open={open} onClose={onClose} busy={pending} title={t.knowledge.settings}>
      <div className="flex flex-wrap justify-end gap-2">
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

/** Moves an uploaded document to the Space or one of its Sections (nothing is copied). */
function MoveItemDialog({
  item,
  targets,
  onClose,
  onMoved,
}: {
  item: ItemView | null;
  targets: SpaceSummary[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState("");
  const [pending, startTransition] = useTransition();
  const choice = target || targets[0]?.id || "";
  return (
    <Dialog
      open={Boolean(item)}
      onClose={onClose}
      busy={pending}
      title={t.knowledge.sections.moveTitle(item?.title ?? "")}
    >
      <div className="flex flex-col gap-4">
        <Select
          aria-label={t.knowledge.sections.moveTo}
          value={choice}
          onChange={(e) => setTarget(e.target.value)}
        >
          {targets.map((x) => (
            <option key={x.id} value={x.id}>
              {x.path}
            </option>
          ))}
        </Select>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t.knowledge.cancel}
          </Button>
          <Button
            disabled={pending || !choice || !item}
            onClick={() =>
              startTransition(async () => {
                const r = await moveItemAction(item!.id, choice);
                if (!r.ok) toast.error(errorText(t, r.error));
                else {
                  toast.success(t.knowledge.sections.moved);
                  onMoved();
                }
              })
            }
          >
            {t.knowledge.sections.move}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
