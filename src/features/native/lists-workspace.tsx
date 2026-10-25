"use client";

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useOptimistic,
  useRef,
  useState,
  useTransition,
  type DragEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { OverflowMenu } from "@/components/ui/sheet-menu";
import {
  LIST_ITEM_SORTS,
  splitItems,
  type ListItem,
  type ListItemSort,
  type NativeList,
} from "@/core/capabilities/lists";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { nativeActionAction, reorderListAction, reorderListsAction } from "./actions";
import { ImportPanel } from "./import-panel";
import { ShoppingCompare } from "./shopping-compare";

/**
 * My Elise → Lists (ADR-051): checklists as columns side by side, scrolled horizontally. Lists
 * are NOT tasks — no dates, priorities or providers. Every change runs the canonical lists.*
 * tool (same path as Chat) with an optimistic update; a failure restores the board.
 */

type Change =
  | { kind: "item"; id: string; patch: Partial<ListItem> }
  | { kind: "addItems"; listId: string; items: ListItem[] }
  | { kind: "removeItem"; id: string }
  | { kind: "moveItem"; id: string; toListId: string; position: number }
  | { kind: "orderItems"; listId: string; ids: string[] }
  | { kind: "list"; id: string; patch: Partial<NativeList> }
  | { kind: "removeList"; id: string }
  | { kind: "orderLists"; ids: string[] }
  | { kind: "clearDone"; listId: string };

function reduce(lists: NativeList[], c: Change): NativeList[] {
  const items = (fn: (l: NativeList) => ListItem[]) => lists.map((l) => ({ ...l, items: fn(l) }));
  switch (c.kind) {
    case "item":
      return items((l) => l.items.map((i) => (i.id === c.id ? { ...i, ...c.patch } : i)));
    case "addItems":
      return items((l) => (l.id === c.listId ? [...l.items, ...c.items] : l.items));
    case "removeItem":
      return items((l) => l.items.filter((i) => i.id !== c.id));
    case "moveItem": {
      const moving = lists.flatMap((l) => l.items).find((i) => i.id === c.id);
      if (!moving) return lists;
      return items((l) => [
        ...l.items.filter((i) => i.id !== c.id),
        ...(l.id === c.toListId ? [{ ...moving, listId: l.id, position: c.position }] : []),
      ]);
    }
    case "orderItems":
      return items((l) =>
        l.id !== c.listId
          ? l.items
          : l.items.map((i) => {
              const at = c.ids.indexOf(i.id);
              return at < 0 ? i : { ...i, position: (at + 1) * 1024 };
            }),
      );
    case "list":
      return lists.map((l) => (l.id === c.id ? { ...l, ...c.patch } : l));
    case "removeList":
      return lists.filter((l) => l.id !== c.id);
    case "orderLists":
      return [...lists].sort((a, b) => c.ids.indexOf(a.id) - c.ids.indexOf(b.id));
    case "clearDone":
      return items((l) => (l.id === c.listId ? l.items.filter((i) => !i.checked) : l.items));
  }
}

const SCROLL_KEY = "elise.lists.scroll";
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function ListsWorkspace({
  lists: initial,
  workspaceId,
  focus,
}: {
  lists: NativeList[];
  workspaceId: string;
  focus: string | null;
}) {
  const { t } = useI18n();
  const w = t.native.lists.ws;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [lists, apply] = useOptimistic(initial, reduce);
  useRealtimeRefresh(workspaceId, ["lists", "list_items"]);

  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ kind: "item" | "list"; id: string; listId?: string } | null>(
    null,
  );
  const board = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusNext = useRef<string | null>(focus);
  const [edges, setEdges] = useState({ left: false, right: false });

  /** One change: optimistic first, the tool's truth after (a failure restores). */
  const act = useCallback(
    (
      tool: string,
      args: Record<string, unknown>,
      change?: Change,
      after?: () => Promise<unknown>,
    ) =>
      startTransition(async () => {
        if (change) apply(change);
        const r = await nativeActionAction(tool, args);
        if (!r.ok) {
          toast.error(`${w.failed} ${errorText(t, r.error)}`);
          return;
        }
        if (after) await after();
        router.refresh();
      }),
    [apply, router, t, w.failed],
  );

  const run = useCallback(
    (change: Change, call: () => Promise<{ ok: boolean; error?: { code: string } }>) =>
      startTransition(async () => {
        apply(change);
        const r = await call();
        if (!r.ok && r.error) toast.error(`${w.failed} ${errorText(t, r.error)}`);
        router.refresh();
      }),
    [apply, router, t, w.failed],
  );

  // The board's horizontal position survives navigation within the session.
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    try {
      const saved = Number(sessionStorage.getItem(SCROLL_KEY));
      if (saved && !focusNext.current) el.scrollLeft = saved;
    } catch {
      // Storage blocked: starts at the left.
    }
    const onScroll = () => {
      setEdges({
        left: el.scrollLeft > 8,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8,
      });
      try {
        sessionStorage.setItem(SCROLL_KEY, String(el.scrollLeft));
      } catch {
        // Not remembered.
      }
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // A list asked for (?focus=, a new list, the navigator) scrolls into view.
  const reveal = useCallback((id: string, input = false) => {
    const col = document.querySelector<HTMLElement>(`[data-list-col="${CSS.escape(id)}"]`);
    if (!col) return false;
    col.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    if (input)
      col.querySelector<HTMLInputElement>("[data-add-item]")?.focus({ preventScroll: true });
    return true;
  }, []);
  useEffect(() => {
    const want = focusNext.current === "__last__" ? lists.at(-1)?.id : focusNext.current;
    if (want && reveal(want, true)) focusNext.current = null;
  }, [lists, reveal]);

  // Keyboard: / search · N add to the first visible list · Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName ?? "");
      if (e.key === "Escape") {
        if (typing) el!.blur();
        else setDetail(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        board.current?.querySelector<HTMLInputElement>("[data-add-item]")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const q = norm(search.trim());
  const [switching, setSwitching] = useState(false);
  const [inView, setInView] = useState(0);
  const shown = q
    ? lists
        .map((l) =>
          norm(l.name).includes(q)
            ? l
            : {
                ...l,
                items: l.items.filter((i) =>
                  [i.content, i.notes ?? "", ...(i.labels ?? [])].some((v) => norm(v).includes(q)),
                ),
              },
        )
        .filter((l) => l.items.length || norm(l.name).includes(q))
    : lists;

  const moveList = (id: string, delta: number) => {
    const ids = lists.map((l) => l.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    run({ kind: "orderLists", ids }, () => reorderListsAction(ids));
  };

  const dropOnList = (listId: string, beforeItemId: string | null) => {
    if (!drag) return;
    setDrag(null);
    if (drag.kind === "list") {
      if (drag.id === listId) return;
      const ids = lists.map((l) => l.id).filter((id) => id !== drag.id);
      ids.splice(ids.indexOf(listId), 0, drag.id);
      run({ kind: "orderLists", ids }, () => reorderListsAction(ids));
      return;
    }
    const target = lists.find((l) => l.id === listId);
    if (!target) return;
    const order = splitItems(target)
      .active.map((i) => i.id)
      .filter((id) => id !== drag.id);
    const at = beforeItemId ? order.indexOf(beforeItemId) : -1;
    order.splice(at < 0 ? order.length : at, 0, drag.id);
    if (drag.listId === listId) {
      if (target.itemSort && target.itemSort !== "manual") return; // only "my order" is draggable
      run({ kind: "orderItems", listId, ids: order }, () => reorderListAction(listId, order));
    } else {
      act(
        "lists.moveItem",
        { list: drag.listId, item: drag.id, to: listId },
        {
          kind: "moveItem",
          id: drag.id,
          toListId: listId,
          position: (order.indexOf(drag.id) + 0.5) * 1024,
        },
        () => reorderListAction(listId, order),
      );
    }
  };

  const detailItem = lists.flatMap((l) => l.items).find((i) => i.id === detail) ?? null;
  const current = shown[Math.min(inView, shown.length - 1)] ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/*
        Phones (ADR-066): one list at a time. The switcher is a full-width row naming the list in
        view; it opens every list in a sheet. "Nueva lista" stays; import goes to ⋯.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1 max-md:order-last max-md:basis-full sm:max-w-xs">
          <span className="sr-only">{w.search}</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint"
            aria-hidden
          />
          <Input
            ref={searchRef}
            type="search"
            value={search}
            placeholder={w.search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-8 text-[13.5px] max-md:h-11"
          />
        </label>
        {lists.length > 1 && current && (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`${w.jumpTo}: ${current.name}`}
            onClick={() => setSwitching(true)}
            className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-border pr-3 pl-4 text-left md:hidden"
          >
            <span className="min-w-0 flex-1 truncate text-[16px] font-medium">
              {[current.icon, current.name].filter(Boolean).join(" ")}
            </span>
            <span className="font-mono text-[12px] text-faint">
              {current.items.filter((i) => !i.checked).length}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
          </button>
        )}
        <Dialog open={switching} onClose={() => setSwitching(false)} title={w.jumpTo}>
          <ul className="-mx-2 -mt-2 flex flex-col">
            {lists.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  aria-current={l.id === current?.id ? "true" : undefined}
                  onClick={() => {
                    setSwitching(false);
                    reveal(l.id);
                  }}
                  className={cn(
                    "flex h-13 w-full items-center gap-3 rounded-2xl px-3 text-left text-[16px]",
                    l.id === current?.id ? "bg-active" : "active:bg-surface-2",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {[l.icon, l.name].filter(Boolean).join(" ")}
                  </span>
                  <span className="font-mono text-[12.5px] text-faint">
                    {l.items.filter((i) => !i.checked).length}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
        {lists.length > 3 && (
          <Select
            aria-label={w.jumpTo}
            value=""
            onChange={(e) => e.target.value && reveal(e.target.value)}
            className="h-9 w-auto max-w-[14rem] py-0 text-[13px] max-md:hidden"
          >
            <option value="">{w.jumpTo}</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {[l.icon, l.name].filter(Boolean).join(" ")}
              </option>
            ))}
          </Select>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="max-md:hidden"
            onClick={() => setImporting((v) => !v)}
          >
            {t.native.importCsv}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)} className="max-md:h-11">
            <Plus />
            <span className="max-sm:sr-only">{w.newList}</span>
          </Button>
          <div className="md:hidden">
            <OverflowMenu
              label={t.common.moreActions}
              items={[{ label: t.native.importCsv, onClick: () => setImporting((v) => !v) }]}
            />
          </div>
        </div>
      </div>
      {importing && <ImportPanel kind="lists" onDone={() => setImporting(false)} />}

      <div className="relative">
        {edges.left && (
          <EdgeButton
            side="left"
            label={w.prev}
            onClick={() => board.current?.scrollBy({ left: -340, behavior: "smooth" })}
          />
        )}
        {edges.right && (
          <EdgeButton
            side="right"
            label={w.next}
            onClick={() => board.current?.scrollBy({ left: 340, behavior: "smooth" })}
          />
        )}
        <div
          ref={board}
          onScroll={(e) => {
            // The list in view on phones (one column at a time), for the switcher.
            const el = e.currentTarget;
            const first = el.firstElementChild as HTMLElement | null;
            if (!first) return;
            setInView(Math.round(el.scrollLeft / (first.offsetWidth + 12)));
          }}
          className="lists-board flex snap-x snap-mandatory items-start gap-3 overflow-x-auto pb-3 max-md:no-scrollbar md:snap-none md:[scrollbar-width:thin]"
        >
          {shown.map((list) => (
            <Column
              key={list.id}
              list={list}
              searching={Boolean(q)}
              index={lists.findIndex((l) => l.id === list.id)}
              count={lists.length}
              act={act}
              onMove={moveList}
              onOpen={setDetail}
              drag={drag}
              setDrag={setDrag}
              onDrop={dropOnList}
            />
          ))}
          {q && shown.length === 0 && (
            <p className="px-2 py-6 text-[13.5px] text-muted">{w.noMatches}</p>
          )}
          {creating ? (
            <NewListColumn
              onCancel={() => setCreating(false)}
              onCreate={(name) => {
                setCreating(false);
                act("lists.create", { name }, undefined, async () => {
                  focusNext.current = "__last__";
                });
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex h-12 w-[260px] shrink-0 snap-center items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-[13px] text-muted hover:border-accent-line hover:text-fg"
            >
              <Plus className="size-4" aria-hidden />
              {w.newList}
            </button>
          )}
        </div>
      </div>

      {detailItem && (
        <ItemDetail
          key={detailItem.id}
          item={detailItem}
          lists={lists}
          act={act}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

function EdgeButton({
  side,
  label,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "absolute top-3 z-10 hidden size-8 place-items-center rounded-full border border-border bg-[var(--menu-bg)] text-muted backdrop-blur hover:text-fg md:grid",
        side === "left" ? "-left-3" : "-right-3",
      )}
    >
      {side === "left" ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
    </button>
  );
}

type Act = (
  tool: string,
  args: Record<string, unknown>,
  change?: Change,
  after?: () => Promise<unknown>,
) => void;

function Column({
  list,
  searching,
  index,
  count,
  act,
  onMove,
  onOpen,
  drag,
  setDrag,
  onDrop,
}: {
  list: NativeList;
  searching: boolean;
  index: number;
  count: number;
  act: Act;
  onMove: (id: string, delta: number) => void;
  onOpen: (itemId: string) => void;
  drag: { kind: "item" | "list"; id: string; listId?: string } | null;
  setDrag: (d: { kind: "item" | "list"; id: string; listId?: string } | null) => void;
  onDrop: (listId: string, beforeItemId: string | null) => void;
}) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const w = t.native.lists.ws;
  const { active, done } = splitItems(list);
  const [showDone, setShowDone] = useState(done.length > 0 && done.length <= 3);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<"name" | "description" | "icon" | null>(null);
  const [value, setValue] = useState("");
  const [menu, setMenu] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [over, setOver] = useState(false);
  const manual = (list.itemSort ?? "manual") === "manual";

  const add = () => {
    const entries = draft
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!entries.length) return;
    setDraft("");
    const now = new Date().toISOString();
    const last = Math.max(0, ...list.items.map((i) => i.position));
    act(
      "lists.addItem",
      { list: list.id, items: entries },
      {
        kind: "addItems",
        listId: list.id,
        items: entries.map((content, n) => ({
          id: `pending-${now}-${n}`,
          listId: list.id,
          content,
          checked: false,
          position: last + (n + 1) * 1024,
          notes: null,
          labels: [],
          createdAt: now,
        })),
      },
    );
  };

  const save = () => {
    const v = value.trim();
    if (editing === "name" && v && v !== list.name)
      act(
        "lists.update",
        { list: list.id, name: v },
        { kind: "list", id: list.id, patch: { name: v } },
      );
    if (editing === "description" && v !== (list.description ?? ""))
      act(
        "lists.update",
        { list: list.id, description: v || null },
        { kind: "list", id: list.id, patch: { description: v || null } },
      );
    if (editing === "icon" && v !== (list.icon ?? ""))
      act(
        "lists.update",
        { list: list.id, icon: v || null },
        { kind: "list", id: list.id, patch: { icon: v || null } },
      );
    setEditing(null);
  };
  const edit = (what: "name" | "description" | "icon") => {
    setMenu(false);
    setValue(
      what === "name"
        ? list.name
        : what === "description"
          ? (list.description ?? "")
          : (list.icon ?? ""),
    );
    setEditing(what);
  };

  const toggle = (item: ListItem) =>
    act(
      item.checked ? "lists.uncheckItem" : "lists.checkItem",
      { list: list.id, item: item.id },
      {
        kind: "item",
        id: item.id,
        patch: {
          checked: !item.checked,
          checkedAt: item.checked ? null : new Date().toISOString(),
        },
      },
    );

  return (
    <section
      data-list-col={list.id}
      aria-label={list.name}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDrop(list.id, null);
      }}
      className={cn(
        "flex max-h-[calc(100dvh-15rem)] w-[calc(100vw-2rem)] shrink-0 snap-center flex-col rounded-xl border bg-surface sm:w-[300px] lg:w-[312px]",
        over ? "border-accent-line" : "border-border",
        drag?.kind === "list" && drag.id === list.id && "opacity-50",
      )}
    >
      <header className="flex items-center gap-1 border-b border-border py-1.5 pr-1 pl-1.5">
        <span
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            setDrag({ kind: "list", id: list.id });
          }}
          onDragEnd={() => setDrag(null)}
          title={w.dragHint}
          className="hidden cursor-grab text-faint hover:text-muted active:cursor-grabbing md:block"
        >
          <GripVertical className="size-4" aria-hidden />
        </span>
        {editing === "icon" ? (
          <InlineInput
            value={value}
            setValue={setValue}
            onSave={save}
            onCancel={() => setEditing(null)}
            label={w.iconPrompt}
            className="w-14"
            maxLength={16}
          />
        ) : (
          list.icon && (
            <span className="text-[16px] leading-none" aria-hidden>
              {list.icon}
            </span>
          )
        )}
        {editing === "name" ? (
          <InlineInput
            value={value}
            setValue={setValue}
            onSave={save}
            onCancel={() => setEditing(null)}
            label={w.rename}
            className="flex-1"
            maxLength={120}
          />
        ) : (
          <button
            type="button"
            onClick={() => edit("name")}
            className="min-w-0 flex-1 truncate px-1 text-left text-[14px] font-medium"
            title={w.rename}
          >
            {list.name}
          </button>
        )}
        <span className="font-mono text-[11px] text-faint">{active.length || ""}</span>
        <div className="relative">
          <button
            type="button"
            aria-label={w.menu(list.name)}
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
            className="grid size-7 place-items-center rounded-lg text-muted hover:bg-active hover:text-fg"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
          {comparing && (
            <ShoppingCompare
              list={{ id: list.id, name: list.name }}
              onClose={() => setComparing(false)}
            />
          )}
          {menu && (
            <ListMenu
              list={list}
              doneCount={done.length}
              index={index}
              count={count}
              onClose={() => setMenu(false)}
              onEdit={edit}
              onSort={(sort) =>
                act(
                  "lists.update",
                  { list: list.id, sort },
                  { kind: "list", id: list.id, patch: { itemSort: sort } },
                )
              }
              onDuplicate={() => act("lists.duplicate", { list: list.id })}
              onCompare={() => setComparing(true)}
              onClearDone={async () => {
                if (
                  await confirm({
                    title: w.clearDoneConfirm(done.length, list.name),
                    destructive: true,
                  })
                )
                  act(
                    "lists.clearChecked",
                    { list: list.id },
                    { kind: "clearDone", listId: list.id },
                  );
              }}
              onMove={(d) => onMove(list.id, d)}
              onDelete={async () => {
                if (
                  await confirm({
                    title: w.deleteConfirm(list.name, list.items.length),
                    destructive: true,
                  })
                )
                  act("lists.archive", { list: list.id }, { kind: "removeList", id: list.id });
              }}
            />
          )}
        </div>
      </header>
      {editing === "description" ? (
        <div className="border-b border-border px-3 py-2">
          <textarea
            autoFocus
            value={value}
            aria-label={w.description}
            placeholder={w.descriptionPrompt}
            maxLength={1000}
            rows={2}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(null);
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                save();
              }
            }}
            className="w-full resize-none bg-transparent text-[12.5px] outline-none placeholder:text-faint"
          />
        </div>
      ) : (
        list.description && (
          <p className="line-clamp-2 border-b border-border px-3 py-1.5 text-[12px] text-muted">
            {list.description}
          </p>
        )
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
        {active.length === 0 && !searching && (
          <p className="px-3 pt-2 text-[12.5px] text-faint">{w.emptyList}</p>
        )}
        <ul>
          {active.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              draggable={manual || drag?.listId !== list.id}
              onToggle={() => toggle(item)}
              onOpen={() => onOpen(item.id)}
              onDragStart={() => setDrag({ kind: "item", id: item.id, listId: list.id })}
              onDragEnd={() => setDrag(null)}
              onDropBefore={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOver(false);
                onDrop(list.id, item.id);
              }}
              dragging={drag?.kind === "item" && drag.id === item.id}
            />
          ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          className="flex items-center gap-2 px-3 py-1.5"
        >
          <Plus className="size-3.5 shrink-0 text-accent-text" aria-hidden />
          <input
            data-add-item=""
            value={draft}
            maxLength={500}
            aria-label={`${w.addItem} · ${list.name}`}
            placeholder={w.addItem}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setDraft(""), e.currentTarget.blur())}
            className="h-7 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-faint"
          />
        </form>
        {done.length > 0 && (
          <div className="mt-1 border-t border-border">
            <button
              type="button"
              aria-expanded={showDone || searching}
              onClick={() => setShowDone((v) => !v)}
              className="flex w-full items-center gap-1 px-3 py-1.5 text-[12.5px] text-muted hover:text-fg"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform",
                  (showDone || searching) && "rotate-90",
                )}
                aria-hidden
              />
              {w.done(done.length)}
            </button>
            {(showDone || searching) && (
              <ul>
                {done.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    draggable={false}
                    onToggle={() => toggle(item)}
                    onOpen={() => onOpen(item.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function InlineInput({
  value,
  setValue,
  onSave,
  onCancel,
  label,
  className,
  maxLength,
}: {
  value: string;
  setValue: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  label: string;
  className?: string;
  maxLength: number;
}) {
  return (
    <input
      autoFocus
      value={value}
      aria-label={label}
      placeholder={label}
      maxLength={maxLength}
      onChange={(e) => setValue(e.target.value)}
      onBlur={onSave}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSave();
        if (e.key === "Escape") onCancel();
      }}
      className={cn(
        "h-7 min-w-0 rounded-md border border-accent-line bg-transparent px-1.5 text-[13.5px] outline-none",
        className,
      )}
    />
  );
}

function ListMenu({
  list,
  doneCount,
  index,
  count,
  onClose,
  onEdit,
  onSort,
  onDuplicate,
  onCompare,
  onClearDone,
  onMove,
  onDelete,
}: {
  list: NativeList;
  doneCount: number;
  index: number;
  count: number;
  onClose: () => void;
  onEdit: (what: "name" | "description" | "icon") => void;
  onSort: (sort: ListItemSort) => void;
  onDuplicate: () => void;
  /** ADR-111: this list's prices at the supermarkets (any list; it's read-only). */
  onCompare: () => void;
  onClearDone: () => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const w = t.native.lists.ws;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const item = (
    label: ReactNode,
    fn: () => void,
    opts: { danger?: boolean; disabled?: boolean; checked?: boolean } = {},
  ) => (
    <button
      type="button"
      role={opts.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={opts.checked}
      disabled={opts.disabled}
      onClick={() => {
        fn();
        onClose();
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-active disabled:opacity-40",
        opts.danger ? "text-danger-text" : "text-fg2",
      )}
    >
      {opts.checked !== undefined && (
        <span
          className={cn("size-1.5 rounded-full", opts.checked ? "bg-accent" : "bg-transparent")}
        />
      )}
      {label}
    </button>
  );
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={w.menu(list.name)}
      className="absolute top-8 right-0 z-30 w-56 rounded-xl border border-border-strong bg-[var(--menu-bg)] p-1 shadow-lg backdrop-blur"
    >
      <p className="px-2.5 pt-1.5 pb-1 font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
        {w.sortBy}
      </p>
      {LIST_ITEM_SORTS.map((s) =>
        item(w.sorts[s], () => onSort(s), { checked: (list.itemSort ?? "manual") === s }),
      )}
      <div className="my-1 border-t border-border" />
      {item(w.rename, () => onEdit("name"))}
      {item(w.editDescription, () => onEdit("description"))}
      {item(w.changeIcon, () => onEdit("icon"))}
      {item(w.moveLeft, () => onMove(-1), { disabled: index <= 0 })}
      {item(w.moveRight, () => onMove(1), { disabled: index >= count - 1 })}
      {item(w.duplicate, onDuplicate)}
      {item(t.shopping.compare, onCompare, { disabled: !list.items.some((i) => !i.checked) })}
      {item(w.clearDone, onClearDone, { disabled: doneCount === 0 })}
      <div className="my-1 border-t border-border" />
      {item(w.deleteList, onDelete, { danger: true })}
    </div>
  );
}

function ItemRow({
  item,
  draggable,
  onToggle,
  onOpen,
  onDragStart,
  onDragEnd,
  onDropBefore,
  dragging,
}: {
  item: ListItem;
  draggable: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDropBefore?: (e: DragEvent) => void;
  dragging?: boolean;
}) {
  const { t } = useI18n();
  const w = t.native.lists.ws;
  const pending = item.id.startsWith("pending-");
  const meta = [item.notes?.split("\n")[0], ...(item.labels ?? [])].filter(Boolean).join(" · ");
  return (
    <li
      draggable={draggable && !pending}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => onDropBefore && e.preventDefault()}
      onDrop={onDropBefore}
      className={cn(
        "group flex items-center gap-3 px-3 hover:bg-active md:items-start md:gap-2.5 md:py-[5px]",
        dragging && "opacity-40",
        pending && "opacity-60",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={item.checked}
        aria-label={item.checked ? w.uncheck(item.content) : w.check(item.content)}
        disabled={pending}
        onClick={onToggle}
        className={cn(
          "touch-hit grid size-5 shrink-0 place-items-center rounded-full border transition-colors duration-150 md:mt-[3px] md:size-[16px]",
          item.checked
            ? "border-accent bg-accent text-accent-fg"
            : "border-border-strong hover:border-accent",
        )}
      >
        {item.checked && (
          <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden>
            <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        )}
      </button>
      <button
        type="button"
        onClick={onOpen}
        disabled={pending}
        className="min-h-11 min-w-0 flex-1 py-2.5 text-left md:min-h-0 md:py-0"
      >
        <span
          className={cn(
            "block text-[15px] leading-6 md:text-[13.5px] md:leading-5",
            item.checked && "text-faint line-through",
          )}
        >
          {item.content}
        </span>
        {meta && <span className="block truncate text-[11.5px] text-faint">{meta}</span>}
      </button>
    </li>
  );
}

function NewListColumn({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const w = t.native.lists.ws;
  const [name, setName] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onCreate(name.trim());
      }}
      className="flex w-[calc(100vw-2rem)] shrink-0 snap-center flex-col gap-2 rounded-xl border border-accent-line bg-surface p-3 sm:w-[300px]"
    >
      <input
        autoFocus
        value={name}
        maxLength={120}
        aria-label={w.newListName}
        placeholder={w.newListName}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        onBlur={() => !name.trim() && onCancel()}
        className="h-8 bg-transparent text-[14px] font-medium outline-none placeholder:text-faint"
      />
    </form>
  );
}

/** One item, lightly: name, description, labels, list, completed, delete. Never Task fields. */
function ItemDetail({
  item,
  lists,
  act,
  onClose,
}: {
  item: ListItem;
  lists: NativeList[];
  act: Act;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const w = t.native.lists.ws;
  const [content, setContent] = useState(item.content);
  const [notes, setNotes] = useState(item.notes ?? "");
  const [label, setLabel] = useState("");
  const allLabels = [
    ...new Set(lists.flatMap((l) => l.items.flatMap((i) => i.labels ?? []))),
  ].sort();
  const base = { list: item.listId, item: item.id };
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={w.itemDetail}
    >
      <button
        type="button"
        aria-label={w.close}
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative flex h-full w-full flex-col gap-4 overflow-y-auto border-l border-border bg-bg p-5 sm:max-w-[400px]">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
            {w.itemDetail}
          </span>
          <button
            type="button"
            aria-label={w.close}
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-muted hover:bg-active hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </div>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          {w.name}
          <input
            autoFocus
            value={content}
            maxLength={500}
            onChange={(e) => setContent(e.target.value)}
            onBlur={() => {
              const v = content.trim();
              if (v && v !== item.content)
                act(
                  "lists.updateItem",
                  { ...base, content: v },
                  { kind: "item", id: item.id, patch: { content: v } },
                );
            }}
            className="rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-[15px] text-fg outline-none focus:border-accent-line"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          {w.description}
          <textarea
            value={notes}
            maxLength={1000}
            rows={4}
            placeholder={w.descriptionPlaceholder}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => {
              const v = notes.trim();
              if (v !== (item.notes ?? ""))
                act(
                  "lists.updateItem",
                  { ...base, notes: v || null },
                  { kind: "item", id: item.id, patch: { notes: v || null } },
                );
            }}
            className="resize-y rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-[13.5px] text-fg outline-none placeholder:text-faint focus:border-accent-line"
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted">{w.labels}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {(item.labels ?? []).map((l) => (
              <span
                key={l}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[12px] text-accent-text"
              >
                {l}
                <button
                  type="button"
                  aria-label={w.removeLabel(l)}
                  onClick={() =>
                    act(
                      "lists.updateItem",
                      { ...base, removeLabels: [l] },
                      {
                        kind: "item",
                        id: item.id,
                        patch: { labels: (item.labels ?? []).filter((x) => x !== l) },
                      },
                    )
                  }
                  className="text-faint hover:text-fg"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            <input
              value={label}
              list="list-label-options"
              maxLength={60}
              placeholder={`+ ${w.addLabel}`}
              aria-label={w.addLabel}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const v = label.trim();
                setLabel("");
                if (!v || (item.labels ?? []).some((x) => norm(x) === norm(v))) return;
                act(
                  "lists.updateItem",
                  { ...base, addLabels: [v] },
                  {
                    kind: "item",
                    id: item.id,
                    patch: { labels: [...(item.labels ?? []), v] },
                  },
                );
              }}
              className="h-7 w-36 bg-transparent text-[12.5px] outline-none placeholder:text-faint"
            />
            <datalist id="list-label-options">
              {allLabels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </div>
        </div>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          {w.list}
          <Select
            value={item.listId}
            onChange={(e) =>
              act(
                "lists.moveItem",
                { ...base, to: e.target.value },
                {
                  kind: "moveItem",
                  id: item.id,
                  toListId: e.target.value,
                  position: Number.MAX_SAFE_INTEGER,
                },
              )
            }
            className="h-9 text-[13.5px]"
          >
            {lists.map((l) => (
              <option key={l.id} value={l.id}>
                {[l.icon, l.name].filter(Boolean).join(" ")}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            checked={item.checked}
            onChange={() =>
              act(item.checked ? "lists.uncheckItem" : "lists.checkItem", base, {
                kind: "item",
                id: item.id,
                patch: {
                  checked: !item.checked,
                  checkedAt: item.checked ? null : new Date().toISOString(),
                },
              })
            }
            className="size-4 accent-[var(--accent)]"
          />
          {w.completed}
        </label>
        <button
          type="button"
          onClick={() => {
            act("lists.removeItem", base, { kind: "removeItem", id: item.id });
            onClose();
          }}
          className="mt-auto inline-flex items-center gap-1.5 self-start text-[13px] text-muted hover:text-danger-text"
        >
          <Trash2 className="size-3.5" aria-hidden />
          {w.deleteItem}
        </button>
      </div>
    </div>
  );
}
