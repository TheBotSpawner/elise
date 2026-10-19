"use client";

import { Check, MoreHorizontal, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NOTE_TAG_COLORS, type NoteTag, type NoteTagColor } from "@/core/capabilities/notes";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { useNative } from "./use-native";

/**
 * Note tags (ADR-088): colored chips, a picker (check, or create by typing), the place to
 * manage every tag, and each note's ⋯ menu (Editar · Etiquetas · Eliminar).
 */

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

/** The tag's color, readable in both themes (globals.css --tag-*); the chip is a tint of it. */
export const tagStyle = (color: NoteTagColor, on = true): CSSProperties => ({
  color: `var(--tag-${color})`,
  background: on ? `color-mix(in srgb, var(--tag-${color}) 14%, transparent)` : undefined,
  borderColor: `color-mix(in srgb, var(--tag-${color}) 35%, transparent)`,
});

export function TagChip({ tag, className }: { tag: NoteTag; className?: string }) {
  return (
    <span
      style={tagStyle(tag.color)}
      className={cn(
        "inline-flex h-5 max-w-40 items-center rounded-full border px-2 text-[11.5px] font-medium",
        className,
      )}
    >
      <span className="truncate">{tag.name}</span>
    </span>
  );
}

/** Closes on outside click or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return root;
}

/** Check the note's tags; typing a new name offers to create it (and tags the note with it). */
export function TagPicker({
  tags,
  value,
  onChange,
  onCreate,
}: {
  tags: NoteTag[];
  value: string[];
  onChange: (names: string[]) => void;
  onCreate: (name: string) => void;
}) {
  const { t } = useI18n();
  const g = t.native.notes.tags;
  const [q, setQ] = useState("");
  const shown = tags.filter((x) => !q.trim() || fold(x.name).includes(fold(q)));
  const exact = tags.some((x) => fold(x.name) === fold(q));
  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);
  return (
    <div className="flex w-64 flex-col gap-1">
      <Input
        autoFocus
        aria-label={g.searchOrCreate}
        placeholder={g.searchOrCreate}
        value={q}
        maxLength={40}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          if (q.trim() && !exact) onCreate(q.trim());
          else if (shown[0]) toggle(shown[0].name);
          setQ("");
        }}
        className="h-9"
      />
      <ul className="flex max-h-60 flex-col overflow-y-auto">
        {shown.map((x) => {
          const on = value.includes(x.name);
          return (
            <li key={x.id}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => toggle(x.name)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13.5px] hover:bg-active focus-visible:bg-active focus-visible:outline-none"
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded border",
                    on ? "border-accent bg-accent text-accent-fg" : "border-border-strong",
                  )}
                >
                  {on && <Check className="size-3" strokeWidth={3} />}
                </span>
                <TagChip tag={x} />
              </button>
            </li>
          );
        })}
        {q.trim() && !exact && (
          <li>
            <button
              type="button"
              onClick={() => {
                onCreate(q.trim());
                setQ("");
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px] text-accent-text hover:bg-active"
            >
              <Plus className="size-3.5" aria-hidden />
              {g.create(q.trim())}
            </button>
          </li>
        )}
        {!tags.length && !q.trim() && (
          <li className="px-2 py-1.5 text-[12.5px] text-faint">{g.none}</li>
        )}
      </ul>
    </div>
  );
}

/** The ⋯ on a note card: Editar · Etiquetas · Eliminar. */
export function NoteMenu({
  note,
  tags,
  onEdit,
}: {
  note: { id: string; title: string; tags?: NoteTag[] };
  tags: NoteTag[];
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const m = t.native.notes.menu;
  const { act, pending } = useNative();
  const confirm = useConfirm();
  const [open, setOpen] = useState<"menu" | "tags" | null>(null);
  const root = useDismiss(open !== null, () => setOpen(null));
  const current = (note.tags ?? []).map((x) => x.name);
  return (
    <div ref={root} className="absolute top-2 right-2">
      <button
        type="button"
        aria-label={m.label(note.title)}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        disabled={pending}
        onClick={() => setOpen(open ? null : "menu")}
        className="grid size-7 place-items-center rounded-full text-faint hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-40 mt-1 rounded-2xl border border-border-strong bg-[var(--overlay-bg)] p-1.5 shadow-[var(--menu-shadow)]"
        >
          {open === "menu" ? (
            <div className="flex min-w-44 flex-col">
              {(
                [
                  [m.edit, Pencil, () => (setOpen(null), onEdit())],
                  [m.tags, Tag, () => setOpen("tags")],
                  [
                    m.delete,
                    Trash2,
                    async () => {
                      setOpen(null);
                      if (
                        await confirm({
                          title: m.deleteConfirm(note.title),
                          confirmLabel: m.delete,
                          destructive: true,
                        })
                      )
                        act("notes.archive", { note: note.id });
                    },
                  ],
                ] as const
              ).map(([label, Icon, run], i) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  autoFocus={i === 0}
                  onClick={() => void run()}
                  className={cn(
                    "flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[14px] hover:bg-active focus-visible:bg-active focus-visible:outline-none",
                    i === 2 && "text-danger-text",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <TagPicker
              tags={tags}
              value={current}
              onChange={(names) => act("notes.tag", { note: note.id, tags: names })}
              onCreate={(name) => act("notes.tag", { note: note.id, add: [name] })}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Every tag in one place: rename, recolor, delete (the notes stay), create. */
export function TagManager({
  open,
  onClose,
  tags,
}: {
  open: boolean;
  onClose: () => void;
  tags: NoteTag[];
}) {
  const { t } = useI18n();
  const g = t.native.notes.tags;
  const { act, pending } = useNative();
  const confirm = useConfirm();
  const [draft, setDraft] = useState("");
  const [color, setColor] = useState<NoteTagColor>("blue");
  const duplicate = (name: string, except?: string) =>
    tags.some((x) => x.id !== except && fold(x.name) === fold(name));

  return (
    <Dialog open={open} onClose={onClose} busy={pending} title={g.manage}>
      <div className="flex flex-col gap-4">
        {tags.length === 0 ? (
          <p className="text-[13.5px] text-muted">{g.managerEmpty}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {tags.map((x) => (
              <li key={x.id} className="flex flex-col gap-2 py-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={g.name}
                    defaultValue={x.name}
                    maxLength={40}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (!name || name === x.name) return void (e.target.value = x.name);
                      if (duplicate(name, x.id)) {
                        e.target.value = x.name;
                        return;
                      }
                      act("notes.saveTag", { tag: x.name, name });
                    }}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    className="h-9 flex-1"
                    style={{ color: `var(--tag-${x.color})` }}
                  />
                  <button
                    type="button"
                    aria-label={g.delete(x.name)}
                    disabled={pending}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: g.deleteConfirm(x.name),
                          confirmLabel: t.native.notes.menu.delete,
                          destructive: true,
                        })
                      )
                        act("notes.deleteTag", { tag: x.name });
                    }}
                    className="grid size-9 place-items-center rounded-full text-faint hover:bg-active hover:text-danger-text"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                </div>
                <Swatches
                  value={x.color}
                  onChange={(c) => act("notes.saveTag", { tag: x.name, color: c })}
                />
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-col gap-2 border-t border-border pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            const name = draft.trim();
            if (!name || duplicate(name)) return;
            act("notes.saveTag", { name, color }, () => setDraft(""));
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label={g.newTag}
              placeholder={g.newTag}
              value={draft}
              maxLength={40}
              onChange={(e) => setDraft(e.target.value)}
              className="h-9 flex-1"
            />
            <Button type="submit" size="sm" disabled={pending || !draft.trim() || duplicate(draft)}>
              <Plus />
              {g.add}
            </Button>
          </div>
          <Swatches value={color} onChange={setColor} />
          {draft.trim() && duplicate(draft) && (
            <p role="alert" className="text-[12.5px] text-danger-text">
              {g.duplicate}
            </p>
          )}
        </form>
      </div>
    </Dialog>
  );
}

function Swatches({
  value,
  onChange,
}: {
  value: NoteTagColor;
  onChange: (c: NoteTagColor) => void;
}) {
  const { t } = useI18n();
  const g = t.native.notes.tags;
  return (
    <div role="radiogroup" className="flex flex-wrap gap-1.5">
      {NOTE_TAG_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={g.color(g.colors[c])}
          onClick={() => onChange(c)}
          className={cn(
            "size-6 rounded-full border-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
            value === c ? "border-fg" : "border-transparent",
          )}
          style={{ background: `var(--tag-${c})` }}
        />
      ))}
    </div>
  );
}
