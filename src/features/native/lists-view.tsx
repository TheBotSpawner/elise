"use client";

import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { NativeList } from "@/core/capabilities/lists";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { reorderListAction } from "./actions";
import { ImportPanel } from "./import-panel";
import { useNative } from "./use-native";

type Summary = { id: string; name: string; total: number; open: number };

/** All lists: open one to check, add and edit — speed first. */
export function ListsIndex({ lists, workspaceId }: { lists: Summary[]; workspaceId: string }) {
  const { t } = useI18n();
  const { act, pending } = useNative();
  const router = useRouter();
  const [name, setName] = useState("");
  const [importing, setImporting] = useState(false);
  useRealtimeRefresh(workspaceId, ["lists", "list_items"]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => setImporting(!importing)}>
          {t.native.importCsv}
        </Button>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act("lists.create", { name }, () => setName(""));
          }}
        >
          <Input
            aria-label={t.native.lists.new}
            placeholder={t.native.lists.namePlaceholder}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            className="w-56"
          />
          <Button type="submit" disabled={pending || !name.trim()}>
            <Plus />
            {t.native.lists.new}
          </Button>
        </form>
      </div>
      {importing && <ImportPanel kind="lists" onDone={() => setImporting(false)} />}
      {lists.length === 0 ? (
        <p className="text-[14px] text-muted">{t.native.empty}</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {lists.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => router.push(`/my-elise/lists/${l.id}`)}
                className="flex w-full items-baseline justify-between gap-3 rounded-2xl border border-border bg-surface px-5 py-4 text-left hover:border-accent-line"
              >
                <span className="truncate font-medium">{l.name}</span>
                <span className="shrink-0 text-[12.5px] text-faint">
                  {t.native.lists.remaining(l.open, l.total)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ListDetail({ list, workspaceId }: { list: NativeList; workspaceId: string }) {
  const { t } = useI18n();
  const { act, pending } = useNative();
  const router = useRouter();
  const [text, setText] = useState("");
  const [hideChecked, setHideChecked] = useState(false);
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [moving, startMove] = useTransition();
  useRealtimeRefresh(workspaceId, ["lists", "list_items"]);

  const items = hideChecked ? list.items.filter((i) => !i.checked) : list.items;
  const move = (index: number, delta: number) => {
    const ids = list.items.map((i) => i.id);
    const from = ids.indexOf(items[index]!.id);
    const to = from + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    startMove(async () => {
      const r = await reorderListAction(list.id, ids);
      if (!r.ok) toast.error(t.errors.codes[r.error.code]);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/my-elise/lists" className="text-[13px] text-muted hover:text-fg">
          ← {t.native.lists.back}
        </Link>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setHideChecked(!hideChecked)}>
            {hideChecked ? t.native.lists.showChecked : t.native.lists.clearChecked}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="hover:text-danger-text"
            disabled={pending}
            onClick={() => {
              if (window.confirm(t.native.archiveConfirm(list.name)))
                act("lists.archive", { list: list.id }, () => router.push("/my-elise/lists"));
            }}
          >
            {t.native.archive}
          </Button>
        </div>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const entries = text
            .split(/[,\n]/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (entries.length)
            act("lists.addItem", { list: list.id, items: entries }, () => setText(""));
        }}
      >
        <Input
          autoFocus
          aria-label={t.native.lists.addItem}
          placeholder={t.native.lists.addItem}
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
        />
      </form>
      <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
        {items.map((item, i) => (
          <li key={item.id} className="group flex items-center gap-3 px-4 py-2.5">
            <input
              type="checkbox"
              aria-label={item.content}
              checked={item.checked}
              disabled={pending}
              onChange={() =>
                act(item.checked ? "lists.uncheckItem" : "lists.checkItem", {
                  list: list.id,
                  item: item.id,
                })
              }
              className="size-4 accent-[var(--accent)]"
            />
            {editing?.id === item.id ? (
              <form
                className="flex-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  act(
                    "lists.updateItem",
                    { list: list.id, item: item.id, content: editing.content },
                    () => setEditing(null),
                  );
                }}
              >
                <Input
                  autoFocus
                  value={editing.content}
                  maxLength={500}
                  onChange={(e) => setEditing({ id: item.id, content: e.target.value })}
                  onBlur={() => setEditing(null)}
                  className="h-8"
                />
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setEditing({ id: item.id, content: item.content })}
                className={cn(
                  "min-w-0 flex-1 truncate text-left text-[14.5px]",
                  item.checked && "text-muted line-through",
                )}
              >
                {item.content}
              </button>
            )}
            <span className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                aria-label={t.native.lists.moveUp}
                disabled={moving}
                onClick={() => move(i, -1)}
                className="p-1 text-faint hover:text-fg"
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={t.native.lists.moveDown}
                disabled={moving}
                onClick={() => move(i, 1)}
                className="p-1 text-faint hover:text-fg"
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                aria-label={t.native.lists.remove}
                disabled={pending}
                onClick={() => act("lists.removeItem", { list: list.id, item: item.id })}
                className="p-1 text-faint hover:text-danger-text"
              >
                <X className="size-3.5" />
              </button>
            </span>
          </li>
        ))}
        {items.length === 0 && (
          <li className="px-4 py-3 text-[14px] text-muted">{t.native.empty}</li>
        )}
      </ul>
    </div>
  );
}
