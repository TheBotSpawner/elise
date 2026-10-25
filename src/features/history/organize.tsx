"use client";

import {
  Archive,
  ArchiveRestore,
  FolderInput,
  FolderMinus,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { OverflowMenu, type MenuAction } from "@/components/ui/sheet-menu";
import type { PublicError } from "@/core/errors";
import type { KnowledgeNode } from "@/core/history/links";
import type { ThreadRef } from "@/core/interaction";
import { SpaceGlyph } from "@/features/knowledge/appearance";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import {
  archiveConversationAction,
  deleteConversationAction,
  deleteVoiceSessionAction,
  moveThreadAction,
  pinThreadAction,
  renameThreadAction,
} from "./actions";

/**
 * Organizing History (ADR-070): a "…" on every conversation (rename, move to a Space, remove
 * from it, pin, archive, delete) and, with a mouse, drag a conversation onto a Space. Both go
 * through the same server actions; drag & drop is only a shortcut, never the only way.
 *
 * Moves are optimistic: the row leaves its folder at once, the server is asked, and History
 * re-reads only on success (router.refresh); a failure puts the row back with a short error.
 */

/** Where an optimistic change sends a row: a Space id, null (no Space) or gone (archived…). */
type Pending = string | null | "gone";

interface Organizer {
  nodes: KnowledgeNode[];
  pending: ReadonlyMap<string, Pending>;
  move(thread: ThreadRef, key: string, spaceId: string | null): void;
  /** Leaves this view at once (archive, unarchive, delete); back if the server says no. */
  remove(
    key: string,
    action: () => Promise<{ ok: true } | { ok: false; error: PublicError }>,
    done: string,
  ): void;
}

const OrganizerContext = createContext<Organizer | null>(null);

function useOrganizer(): Organizer {
  const o = useContext(OrganizerContext);
  if (!o) throw new Error("History organizer missing");
  return o;
}

export function HistoryOrganizer({
  nodes,
  children,
}: {
  nodes: KnowledgeNode[];
  children: ReactNode;
}) {
  const { t } = useI18n();
  const m = t.history.menu;
  const router = useRouter();
  const [pending, setPending] = useState<ReadonlyMap<string, Pending>>(new Map());
  const [, start] = useTransition();
  const label = (id: string | null) =>
    id ? (nodes.find((n) => n.id === id)?.name ?? "") : t.history.untagged;

  function move(thread: ThreadRef, key: string, spaceId: string | null) {
    setPending((p) => new Map(p).set(key, spaceId));
    start(async () => {
      const r = await moveThreadAction(thread, spaceId);
      if (!r.ok) {
        toast.error(m.failed);
      } else {
        toast.success(spaceId ? m.moved(label(spaceId)) : m.removed);
        router.refresh();
      }
      // After the refresh the server's rows are the truth again (or the move is rolled back).
      setPending((p) => {
        const next = new Map(p);
        next.delete(key);
        return next;
      });
    });
  }

  function remove(
    key: string,
    action: () => Promise<{ ok: true } | { ok: false; error: PublicError }>,
    done: string,
  ) {
    setPending((p) => new Map(p).set(key, "gone"));
    start(async () => {
      const r = await action();
      if (!r.ok) toast.error(errorText(t, r.error));
      else {
        toast.success(done);
        router.refresh();
      }
      setPending((p) => {
        const next = new Map(p);
        next.delete(key);
        return next;
      });
    });
  }

  return (
    <OrganizerContext.Provider value={{ nodes, pending, move, remove }}>
      {children}
    </OrganizerContext.Provider>
  );
}

// ── Drag & drop (pointer devices) ────────────────────────────────────────────

let dragging: { thread: ThreadRef; key: string; title: string } | null = null;
const dragListeners = new Set<() => void>();
const setDragging = (d: typeof dragging) => {
  dragging = d;
  dragListeners.forEach((l) => l());
};
const subscribeDrag = (l: () => void) => (dragListeners.add(l), () => void dragListeners.delete(l));
const useDragging = () =>
  useSyncExternalStore(
    subscribeDrag,
    () => dragging,
    () => null,
  );

const MIME = "application/x-elise-thread";

/** Drag & drop only with a mouse or trackpad: on touch the "…" menu is the way. */
const subscribePointer = (l: () => void) => {
  const q = window.matchMedia("(pointer: fine)");
  q.addEventListener("change", l);
  return () => q.removeEventListener("change", l);
};
const useFinePointer = () =>
  useSyncExternalStore(
    subscribePointer,
    () => window.matchMedia("(pointer: fine)").matches,
    () => false,
  );

/**
 * One conversation in a list: draggable with a mouse (never required), and hidden at once
 * while an optimistic change takes it out of this place.
 */
export function ThreadItem({
  thread,
  rowKey,
  title,
  place,
  className,
  children,
}: {
  thread: ThreadRef;
  rowKey: string;
  title: string;
  /** Where this copy of the row is shown: a folder's Space id, null for "Sin Espacio", or "list". */
  place: string | null | "list";
  className?: string;
  children: ReactNode;
}) {
  const { pending } = useOrganizer();
  const fine = useFinePointer();
  const p = pending.get(rowKey);
  const leaving = p === "gone" || (p !== undefined && place !== "list" && p !== place);
  if (leaving) return null;
  return (
    <li
      draggable={fine}
      onDragStart={(e) => {
        e.dataTransfer.setData(MIME, rowKey);
        e.dataTransfer.effectAllowed = "move";
        setDragging({ thread, key: rowKey, title });
      }}
      onDragEnd={() => setDragging(null)}
      className={cn("select-none", className)}
    >
      {children}
    </li>
  );
}

/**
 * A place a conversation can be dropped: a Space or Section (its folder header or filter chip),
 * or "Sin Espacio" (null). Only real Spaces are targets; nothing is inferred.
 */
export function DropTarget({
  spaceId,
  children,
  className,
}: {
  spaceId: string | null;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  // Outside History (no organizer) it's just its children: nothing to move.
  const organizer = useContext(OrganizerContext);
  const current = useDragging();
  const [over, setOver] = useState(false);
  if (!organizer) return <div className={className}>{children}</div>;
  const { move } = organizer;
  const accepts = (e: React.DragEvent) => e.dataTransfer.types.includes(MIME);
  return (
    <div
      onDragOver={(e) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!accepts(e) || !dragging) return;
        e.preventDefault();
        const d = dragging;
        setDragging(null);
        move(d.thread, d.key, spaceId);
      }}
      data-drop-active={current ? (over ? "over" : "ready") : undefined}
      className={cn(
        "relative rounded-xl transition-colors",
        current && "outline-1 outline-accent-line outline-dashed",
        over && "bg-accent-soft outline-accent outline-solid",
        className,
      )}
    >
      {children}
      {over && (
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[11.5px] text-accent-text">
          {t.history.menu.dropHere}
        </span>
      )}
    </div>
  );
}

// ── The "…" menu ─────────────────────────────────────────────────────────────

export function ThreadMenu({
  thread,
  rowKey,
  title,
  primary,
  pinned,
  archived,
}: {
  thread: ThreadRef;
  rowKey: string;
  title: string;
  /** Its folder (null: Sin Espacio). */
  primary: string | null;
  pinned: boolean;
  archived: boolean;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const m = t.history.menu;
  const router = useRouter();
  const { move, remove } = useOrganizer();
  const [, start] = useTransition();
  const [dialog, setDialog] = useState<"move" | "rename" | null>(null);
  const voice = thread.kind === "session";

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: PublicError }>, ok: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(errorText(t, r.error));
      toast.success(ok);
      router.refresh();
    });

  const items: MenuAction[] = [
    { label: m.rename, icon: Pencil, onClick: () => setDialog("rename") },
    ...(archived ? [] : [{ label: m.move, icon: FolderInput, onClick: () => setDialog("move") }]),
    ...(primary && !archived
      ? [{ label: m.removeFromSpace, icon: FolderMinus, onClick: () => move(thread, rowKey, null) }]
      : []),
    ...(archived
      ? []
      : [
          {
            label: pinned ? m.unpin : m.pin,
            icon: pinned ? PinOff : Pin,
            onClick: () =>
              run(() => pinThreadAction(thread, !pinned), pinned ? m.unpinned : m.pinned),
          },
        ]),
    // Voice sessions have no archive of their own (archiving one forgets it): only delete.
    ...(voice
      ? []
      : [
          {
            label: archived ? m.unarchive : m.archive,
            icon: archived ? ArchiveRestore : Archive,
            onClick: () =>
              remove(
                rowKey,
                () => archiveConversationAction(thread.id, !archived),
                archived ? m.unarchived : m.archived,
              ),
          },
        ]),
    {
      label: m.delete,
      icon: Trash2,
      danger: true,
      onClick: async () => {
        if (!(await confirm({ title: m.deleteConfirm(title), destructive: true }))) return;
        remove(
          rowKey,
          () => (voice ? deleteVoiceSessionAction(thread.id) : deleteConversationAction(thread.id)),
          t.chat.deleted,
        );
      },
    },
  ];

  return (
    <>
      <OverflowMenu
        label={m.options(title)}
        items={items}
        className="shrink-0 text-faint md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      />
      <MoveDialog
        open={dialog === "move"}
        current={primary}
        onClose={() => setDialog(null)}
        onPick={(spaceId) => {
          setDialog(null);
          if (spaceId !== primary) move(thread, rowKey, spaceId);
        }}
      />
      <RenameDialog
        open={dialog === "rename"}
        title={title}
        onClose={() => setDialog(null)}
        onSave={(name) => {
          setDialog(null);
          run(() => renameThreadAction(thread, name), m.renamed);
        }}
      />
    </>
  );
}

/** "Mover a Espacio": every Space and Section with its own glyph; search when there are many. */
function MoveDialog({
  open,
  current,
  onClose,
  onPick,
}: {
  open: boolean;
  current: string | null;
  onClose: () => void;
  onPick: (spaceId: string) => void;
}) {
  const { t } = useI18n();
  const m = t.history.menu;
  const { nodes } = useOrganizer();
  const [query, setQuery] = useState("");
  const live = nodes.filter((n) => !n.archived);
  const spaces = live.filter((n) => !n.parentId);
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = fold(query.trim());
  const matches = (n: KnowledgeNode) => !q || fold(n.name).includes(q);
  const rows = spaces.flatMap((s) => {
    const sections = live.filter((n) => n.parentId === s.id && (matches(n) || matches(s)));
    return matches(s) || sections.length ? [{ space: s, sections }] : [];
  });
  return (
    <Dialog open={open} onClose={onClose} title={m.moveTitle}>
      {spaces.length > 6 && (
        <label className="relative block">
          <span className="sr-only">{m.moveSearch}</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
          />
          <Input
            data-autofocus
            value={query}
            placeholder={m.moveSearch}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </label>
      )}
      <ul className="-mx-2 flex max-h-[60dvh] flex-col overflow-y-auto">
        {rows.length === 0 && <li className="px-3 py-3 text-[14px] text-muted">{m.moveNone}</li>}
        {rows.map(({ space, sections }) => (
          <li key={space.id}>
            <SpaceOption node={space} current={current === space.id} onPick={onPick} />
            {sections.map((sec) => (
              <SpaceOption
                key={sec.id}
                node={sec}
                nested
                current={current === sec.id}
                onPick={onPick}
              />
            ))}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function SpaceOption({
  node,
  nested = false,
  current,
  onPick,
}: {
  node: KnowledgeNode;
  nested?: boolean;
  current: boolean;
  onPick: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => onPick(node.id)}
      aria-current={current ? "true" : undefined}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[14.5px] hover:bg-surface-2 md:min-h-10",
        nested && "pl-10 text-[14px] text-fg2",
      )}
    >
      {nested ? null : <SpaceGlyph icon={node.icon} color={node.color} size="sm" />}
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {current && <span className="text-[12px] text-faint">{t.history.menu.current}</span>}
    </button>
  );
}

function RenameDialog({
  open,
  title,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSave: (name: string) => void;
}) {
  const { t } = useI18n();
  const m = t.history.menu;
  return (
    <Dialog open={open} onClose={onClose} title={m.renameTitle}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
          if (name) onSave(name);
        }}
      >
        <Input
          name="name"
          aria-label={m.renameLabel}
          defaultValue={title}
          maxLength={120}
          required
          data-autofocus
        />
        <div data-sheet-actions className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit">{m.save}</Button>
        </div>
      </form>
    </Dialog>
  );
}
