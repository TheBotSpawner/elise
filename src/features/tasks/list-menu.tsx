"use client";

import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { TaskList } from "@/core/capabilities/tasks";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** A small menu at the pointer (right click) or under a ⋯ button. Esc or a click outside closes. */
export function ContextMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number } | null;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)
      )
        onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [at, onClose]);
  if (!at) return null;
  return (
    <div
      ref={ref}
      role="menu"
      style={{
        left: Math.min(at.x, window.innerWidth - 200),
        top: Math.min(at.y, window.innerHeight - 40 * items.length - 16),
      }}
      className="fixed z-50 flex w-48 flex-col rounded-xl border border-border bg-[var(--menu-bg)] p-1 shadow-lg backdrop-blur"
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            it.onSelect();
          }}
          className={cn(
            "flex w-full rounded-lg px-3 py-2 text-left text-[13px] hover:bg-surface-2",
            it.danger && "text-danger-text",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A list in the sidebar with its options (⋯ or right click): rename, and delete — an ELISE list
 * goes for good with its tasks; another account's list is only removed from ELISE and stays in
 * that account. Both ask first, saying exactly which one it is.
 */
export function ListItemWithMenu({
  list,
  children,
  onRename,
  onDelete,
}: {
  list: TaskList;
  children: ReactNode;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const x = t.tasks.ws.listMenu;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(list.name);
  const native = list.provenance.providerKey === "elise_native";
  const deletable = !(native && list.isDefault);

  const items: MenuItem[] = [
    {
      label: x.rename,
      onSelect: () => {
        setName(list.name);
        setRenaming(true);
      },
    },
    ...(deletable
      ? [
          {
            label: native ? x.delete : x.removeFromElise,
            danger: true,
            onSelect: () => setDeleting(true),
          },
        ]
      : []),
  ];

  return (
    <div
      className="group/list relative"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      {children}
      <button
        type="button"
        aria-label={x.options(list.name)}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu({ x: r.left, y: r.bottom + 4 });
        }}
        className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-md bg-bg/80 text-muted opacity-0 group-hover/list:opacity-100 hover:text-fg focus:opacity-100 max-md:opacity-100"
      >
        <MoreHorizontal className="size-3.5" aria-hidden />
      </button>
      <ContextMenu at={menu} items={items} onClose={() => setMenu(null)} />

      <Dialog open={renaming} onClose={() => setRenaming(false)} title={x.renameTitle}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const next = name.trim();
            if (next && next !== list.name) onRename(next);
            setRenaming(false);
          }}
          className="flex flex-col gap-4"
        >
          <Input
            autoFocus
            value={name}
            maxLength={120}
            aria-label={x.renameTitle}
            onChange={(e) => setName(e.target.value)}
          />
          {!native && (
            <p className="text-[12.5px] text-muted">{x.renameRemote(list.provenance.source)}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRenaming(false)}
              className="h-9 rounded-full px-4 text-[13.5px] text-muted"
            >
              {x.cancel}
            </button>
            <button
              type="submit"
              disabled={!name.trim()}
              className="h-9 rounded-full bg-fg px-4 text-[13.5px] font-medium text-bg disabled:opacity-50"
            >
              {x.save}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={native ? x.deleteTitle(list.name) : x.removeTitle(list.name)}
      >
        <p className="text-[14px] text-fg2">
          {native ? x.deleteNative : x.deleteRemote(list.provenance.source)}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setDeleting(false)}
            className="h-9 rounded-full px-4 text-[13.5px] text-muted"
          >
            {x.cancel}
          </button>
          <button
            type="button"
            onClick={() => {
              setDeleting(false);
              onDelete();
            }}
            className="h-9 rounded-full bg-danger px-4 text-[13.5px] font-medium text-white"
          >
            {native ? x.delete : x.removeFromElise}
          </button>
        </div>
      </Dialog>
    </div>
  );
}
