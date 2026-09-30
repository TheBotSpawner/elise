"use client";

import { Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import type { Note } from "@/core/capabilities/notes";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { useNative } from "./use-native";

function Editor({
  note,
  spaces,
  onClose,
}: {
  note: Note | null;
  spaces: { id: string; path: string }[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { act, pending } = useNative();
  const [title, setTitle] = useState(note?.title ?? "");
  const [content, setContent] = useState(note?.content ?? "");
  const [spaceId, setSpaceId] = useState(note?.spaceId ?? "");
  const dirty =
    !note || title !== note.title || content !== note.content || spaceId !== (note.spaceId ?? "");
  const spacePath = spaces.find((s) => s.id === spaceId)?.path;

  function save() {
    if (!title.trim()) return;
    if (!note)
      act("notes.create", { title, content, ...(spacePath ? { space: spaceId } : {}) }, onClose);
    else
      act("notes.update", {
        note: note.id,
        title,
        content,
        ...(spaceId !== (note.spaceId ?? "") ? { space: spaceId || null } : {}),
      });
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5">
      <Input
        aria-label={t.native.notes.titlePlaceholder}
        placeholder={t.native.notes.titlePlaceholder}
        value={title}
        maxLength={300}
        onChange={(e) => setTitle(e.target.value)}
        className="text-base font-medium"
      />
      <textarea
        aria-label={t.native.notes.contentPlaceholder}
        placeholder={t.native.notes.contentPlaceholder}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={14}
        maxLength={100000}
        className="min-h-60 resize-y rounded-xl border border-border-strong bg-transparent px-3.5 py-3 text-[14.5px] leading-[1.6] placeholder:text-faint focus:border-accent focus:outline-none"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select
          aria-label={t.native.notes.space}
          value={spaceId}
          onChange={(e) => setSpaceId(e.target.value)}
          className="h-9 w-auto text-[13px]"
        >
          <option value="">{t.native.notes.noSpace}</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>
              {s.path}
            </option>
          ))}
        </Select>
        <div className="flex gap-1.5">
          {note && (
            <Button
              variant="ghost"
              className="hover:text-danger-text"
              disabled={pending}
              onClick={() => {
                if (window.confirm(t.native.archiveConfirm(note.title)))
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

/** Browse, search and edit notes; filing one in a Space makes it citable Knowledge. */
export function NotesView({
  notes,
  spaces,
  query,
  openId,
  workspaceId,
}: {
  notes: Note[];
  spaces: { id: string; path: string }[];
  query: string;
  openId: string | null;
  workspaceId: string;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = useState(query);
  const [creating, setCreating] = useState(false);
  useRealtimeRefresh(workspaceId, ["notes"]);
  const open = openId ? (notes.find((n) => n.id === openId) ?? null) : null;
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });

  const navigate = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v);
      else p.delete(k);
    }
    router.replace(`${pathname}?${p.toString()}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ q: search.trim() || null, note: null });
          }}
        >
          <Input
            type="search"
            aria-label={t.native.notes.search}
            placeholder={t.native.notes.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-64"
          />
        </form>
        <Button
          onClick={() => {
            navigate({ note: null });
            setCreating(true);
          }}
        >
          <Plus />
          {t.native.notes.new}
        </Button>
      </div>
      {creating && <Editor note={null} spaces={spaces} onClose={() => setCreating(false)} />}
      {open && (
        <Editor
          key={`${open.id}:${open.updatedAt}`}
          note={open}
          spaces={spaces}
          onClose={() => navigate({ note: null })}
        />
      )}
      {notes.length === 0 ? (
        <p className="text-[14px] text-muted">{t.native.empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {notes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  navigate({ note: n.id });
                }}
                className={cn(
                  "flex w-full flex-col gap-0.5 px-5 py-3 text-left hover:bg-surface-2",
                  n.id === openId && "bg-surface-2",
                )}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-[14.5px] font-medium">
                    {n.title || t.native.notes.untitled}
                  </span>
                  <span className="shrink-0 font-mono text-[12px] text-faint">
                    {date.format(new Date(n.updatedAt))}
                  </span>
                </span>
                <span className="truncate text-[13px] text-muted">
                  {n.spaceName && <span className="mr-2 text-accent-text">{n.spaceName}</span>}
                  {n.content.slice(0, 160)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
