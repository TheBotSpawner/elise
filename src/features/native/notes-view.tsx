"use client";

import { ArrowLeft, Check, ChevronDown, Plus, Search, Sparkles, Tags, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { plainText, type Note, type NoteTag } from "@/core/capabilities/notes";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { NoteEditor } from "./note-editor";
import { NoteMenu, TagChip, TagManager, tagStyle } from "./note-tags";
import { useNative } from "./use-native";

/**
 * My Elise → Notes (ADR-056): the list stays on the left while a note is open on the right
 * (stacked on small screens). One note can be filed in several Knowledge Spaces; it stays one
 * note everywhere.
 */

type SpaceOption = { id: string; path: string; general: boolean };

/** "Conocimiento": a popover of checkboxes (stays open while picking) + chips of the chosen. */
function SpacePicker({
  spaces,
  value,
  onChange,
}: {
  spaces: SpaceOption[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const n = t.native.notes;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const shown = spaces.filter((s) => !q.trim() || norm(s.path).includes(norm(q.trim())));
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const chosen = value
    .map((id) => spaces.find((s) => s.id === id))
    .filter(Boolean) as SpaceOption[];
  return (
    <div ref={root} className="relative flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-strong px-3 text-[13px] text-muted hover:border-accent hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        {n.knowledge}
        {!chosen.length && <span className="text-faint">· {n.noSpace}</span>}
        <ChevronDown className="size-3.5" aria-hidden />
      </button>
      {chosen.map((s) => (
        <span
          key={s.id}
          className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-accent-soft pr-1 pl-2.5 text-[12.5px] text-accent-text"
        >
          {s.general && <Sparkles className="size-3 shrink-0" aria-hidden />}
          <span className="truncate">{s.path}</span>
          <button
            type="button"
            aria-label={n.removeSpace(s.path)}
            onClick={() => toggle(s.id)}
            className="grid size-5 place-items-center rounded-full hover:bg-accent/15"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      {open && (
        <div
          role="dialog"
          aria-label={n.knowledge}
          className="absolute top-full left-0 z-40 mt-1.5 flex w-72 flex-col gap-1 rounded-2xl border border-border-strong bg-[var(--overlay-bg)] p-2 shadow-[var(--menu-shadow)]"
        >
          <Input
            autoFocus
            aria-label={n.searchSpaces}
            placeholder={n.searchSpaces}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9"
          />
          <ul className="flex max-h-64 flex-col overflow-y-auto">
            {shown.map((s) => {
              const on = value.includes(s.id);
              return (
                <li key={s.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-active">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(s.id)}
                      className="peer sr-only"
                    />
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded border peer-focus-visible:ring-2 peer-focus-visible:ring-accent",
                        on ? "border-accent bg-accent text-accent-fg" : "border-border-strong",
                      )}
                    >
                      {on && <Check className="size-3" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{s.path}</span>
                    {s.general && <Sparkles className="size-3.5 shrink-0 text-faint" aria-hidden />}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function Editor({
  note,
  spaces,
  onClose,
}: {
  note: Note | null;
  spaces: SpaceOption[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const n = t.native.notes;
  const { act, pending } = useNative();
  const [title, setTitle] = useState(note?.title ?? "");
  const [content, setContent] = useState(note?.content ?? "");
  const [spaceIds, setSpaceIds] = useState<string[]>(note?.spaces.map((s) => s.id) ?? []);
  const original = note?.spaces.map((s) => s.id) ?? [];
  const spacesChanged =
    spaceIds.length !== original.length || spaceIds.some((id, i) => id !== original[i]);
  const dirty = !note || title !== note.title || content !== note.content || spacesChanged;

  function save() {
    if (!title.trim()) return;
    if (!note) {
      act(
        "notes.create",
        { title, content, ...(spaceIds.length ? { spaces: spaceIds } : {}) },
        onClose,
      );
      return;
    }
    if (title !== note.title || content !== note.content)
      act("notes.update", { note: note.id, title, content });
    // Only the Spaces: no re-indexing of unchanged text (ADR-056).
    if (spacesChanged) act("notes.setKnowledgeSpaces", { note: note.id, spaces: spaceIds });
  }

  return (
    <div
      className="flex min-h-0 flex-col gap-3"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (dirty) save();
        }
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={t.native.cancel}
          onClick={onClose}
          className="grid size-9 shrink-0 place-items-center rounded-full text-muted hover:bg-active lg:hidden"
        >
          <ArrowLeft className="size-4" />
        </button>
        <input
          aria-label={n.titlePlaceholder}
          placeholder={n.titlePlaceholder}
          value={title}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[22px] font-light tracking-[-0.01em] placeholder:text-faint focus:outline-none"
        />
      </div>
      <SpacePicker spaces={spaces} value={spaceIds} onChange={setSpaceIds} />
      <NoteEditor value={content} onChange={setContent} label={n.contentPlaceholder} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-faint" aria-live="polite">
          {note && dirty ? n.unsaved : ""}
        </span>
        <div className="flex gap-1.5">
          {note && (
            <Button
              variant="ghost"
              className="hover:text-danger-text"
              disabled={pending}
              onClick={async () => {
                if (
                  await confirm({ title: t.native.archiveConfirm(note.title), destructive: true })
                )
                  act("notes.archive", { note: note.id }, onClose);
              }}
            >
              {t.native.archive}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t.native.cancel}
          </Button>
          <Button onClick={save} disabled={pending || !dirty || !title.trim()}>
            {t.native.save}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Browse, search and edit notes; filing one in Spaces makes it citable Knowledge. */
export function NotesView({
  notes,
  spaces,
  tags = [],
  tagFilter = [],
  query,
  openId,
  workspaceId,
}: {
  notes: Note[];
  spaces: SpaceOption[];
  /** ADR-088: every tag, and the ones the list is filtered by. */
  tags?: NoteTag[];
  tagFilter?: string[];
  query: string;
  openId: string | null;
  workspaceId: string;
}) {
  const { t, locale } = useI18n();
  const n = t.native.notes;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useState(query);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  useRealtimeRefresh(workspaceId, [
    "notes",
    "note_knowledge_spaces",
    "note_tags",
    "note_tag_links",
  ]);
  const g = n.tags;
  const toggleTag = (id: string) => {
    const next = tagFilter.includes(id) ? tagFilter.filter((x) => x !== id) : [...tagFilter, id];
    navigate({ tags: next.join(",") || null, note: null });
  };
  const open = openId ? (notes.find((x) => x.id === openId) ?? null) : null;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  // "Hace 2 horas" is relative to when the list was shown (stable across re-renders).
  const [now] = useState(() => Date.now());
  const when = (iso: string) => {
    const minutes = Math.round((Date.parse(iso) - now) / 60_000);
    if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
    if (Math.abs(minutes) < 60 * 24) return relative.format(Math.round(minutes / 60), "hour");
    if (Math.abs(minutes) < 60 * 24 * 7) return relative.format(Math.round(minutes / 1440), "day");
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(
      new Date(iso),
    );
  };

  const navigate = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const editing = creating || open !== null;

  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[22rem_minmax(0,1fr)]">
      {/* The list stays while a note is open (hidden on small screens while editing). */}
      <section className={cn("flex min-w-0 flex-col gap-3", editing && "max-lg:hidden")}>
        <div className="flex items-center gap-2">
          <form
            className="relative min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ q: search.trim() || null, note: null });
            }}
          >
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
              aria-hidden
            />
            <Input
              type="search"
              aria-label={n.search}
              placeholder={n.search}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </form>
          <Button
            onClick={() => {
              navigate({ note: null });
              setCreating(true);
            }}
          >
            <Plus />
            <span className="max-sm:sr-only">{n.new}</span>
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label={g.manage}
            title={g.manage}
            onClick={() => setManaging(true)}
          >
            <Tags />
          </Button>
        </div>
        {tags.length > 0 && (
          <div role="group" aria-label={g.filter} className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => {
              const on = tagFilter.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleTag(tag.id)}
                  style={tagStyle(tag.color, on)}
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12.5px] font-medium transition-opacity focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
                    !on && "opacity-70 hover:opacity-100",
                  )}
                >
                  {on && <Check className="size-3" strokeWidth={3} aria-hidden />}
                  {tag.name}
                </button>
              );
            })}
            {tagFilter.length > 0 && (
              <button
                type="button"
                onClick={() => navigate({ tags: null })}
                className="h-7 px-1.5 text-[12.5px] text-muted hover:text-fg"
              >
                {g.clear}
              </button>
            )}
          </div>
        )}
        {notes.length === 0 ? (
          <div className="flex flex-col gap-1 rounded-2xl border border-dashed border-border px-5 py-8 text-center">
            <p className="font-medium">
              {tagFilter.length ? g.noMatch : query ? t.native.empty : n.noNotes}
            </p>
            {!query && !tagFilter.length && (
              <p className="text-[13px] text-muted">{n.noNotesBody}</p>
            )}
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {notes.map((x) => {
              const selected = x.id === openId;
              const preview = plainText(x.content).slice(0, 140);
              return (
                <li key={x.id} className="relative">
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => {
                      setCreating(false);
                      navigate({ note: x.id });
                    }}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-2xl border px-4 py-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
                      selected
                        ? "border-accent-line bg-accent-soft/40"
                        : "border-border bg-surface hover:border-border-strong",
                    )}
                  >
                    <span className="truncate pr-8 text-[14.5px] font-medium">
                      {x.title || n.untitled}
                    </span>
                    {preview && (
                      <span className="line-clamp-2 text-[13px] text-muted">{preview}</span>
                    )}
                    {x.tags?.length ? (
                      <span className="flex flex-wrap gap-1">
                        {x.tags.map((tag) => (
                          <TagChip key={tag.id} tag={tag} />
                        ))}
                      </span>
                    ) : null}
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-faint">
                      <span className={x.spaces.length ? "text-accent-text" : undefined}>
                        {x.spaces.length ? x.spaces.map((s) => s.path).join(" · ") : n.noSpace}
                      </span>
                      <span>· {when(x.updatedAt)}</span>
                    </span>
                  </button>
                  <NoteMenu
                    note={x}
                    tags={tags}
                    onEdit={() => {
                      setCreating(false);
                      navigate({ note: x.id });
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section
        className={cn(
          "min-w-0 rounded-2xl border border-border bg-surface p-4 sm:p-5 lg:sticky lg:top-6",
          !editing && "max-lg:hidden",
        )}
      >
        {creating ? (
          <Editor note={null} spaces={spaces} onClose={() => setCreating(false)} />
        ) : open ? (
          <Editor
            key={`${open.id}:${open.updatedAt}:${open.spaces.map((s) => s.id).join(",")}`}
            note={open}
            spaces={spaces}
            onClose={() => navigate({ note: null })}
          />
        ) : (
          <p className="py-16 text-center text-[14px] text-muted">{n.pick}</p>
        )}
      </section>
      <TagManager open={managing} onClose={() => setManaging(false)} tags={tags} />
    </div>
  );
}
