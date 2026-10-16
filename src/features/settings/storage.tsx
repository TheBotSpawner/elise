"use client";

import { Search, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { formatBytes, type StoredFile } from "@/core/storage/accounting";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { deleteStoredFileAction } from "./actions";

/**
 * One storage category (ADR-068): largest or newest first, a search, where each file is used,
 * and Delete only for files uploaded to ELISE. Chat attachments go with their conversation.
 */
export function StoredFiles({ files }: { files: StoredFile[] }) {
  const { t, locale } = useI18n();
  const s = t.settingsHub.storage;
  const [sort, setSort] = useState<"size" | "date">("size");
  const [query, setQuery] = useState("");
  const [pending, start] = useTransition();
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
  const needle = query.trim().toLowerCase();
  const shown = files
    .filter((f) => !needle || `${f.name} ${f.where.label}`.toLowerCase().includes(needle))
    .sort((a, b) => (sort === "size" ? b.bytes - a.bytes : b.createdAt.localeCompare(a.createdAt)));

  function remove(f: StoredFile) {
    if (!f.sourceId || !window.confirm(s.deleteConfirm(f.name))) return;
    start(async () => {
      const r = await deleteStoredFileAction(f.sourceId!);
      if (!r.ok) toast.error(errorText(t, r.error));
      else toast.success(s.deleted);
    });
  }

  if (!files.length)
    return (
      <p className="rounded-2xl border border-dashed border-border px-5 py-8 text-center text-[13.5px] text-muted">
        {s.none}
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">{s.search}</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
          />
          <input
            type="search"
            value={query}
            placeholder={s.search}
            onChange={(e) => setQuery(e.target.value)}
            className="h-10 w-full rounded-full border border-border bg-surface pr-3 pl-9 text-[14px] placeholder:text-faint focus:border-accent focus:outline-none md:h-9 md:text-[13.5px]"
          />
        </label>
        <div role="radiogroup" className="flex gap-1">
          {(["size", "date"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={sort === k}
              onClick={() => setSort(k)}
              className={cn(
                "h-10 rounded-full border px-3.5 text-[13px] md:h-9",
                sort === k
                  ? "border-accent/50 bg-accent-soft text-accent-text"
                  : "border-border text-muted hover:text-fg",
              )}
            >
              {k === "size" ? s.sortSize : s.sortDate}
            </button>
          ))}
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
        {shown.map((f) => (
          <li key={f.id} className="flex items-center gap-3 px-4 py-3 md:px-5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14.5px]">{f.name}</p>
              <p className="truncate text-[12.5px] text-muted">
                <span className="font-mono text-fg2">{formatBytes(f.bytes, locale)}</span>
                {" · "}
                <Link
                  href={
                    f.where.kind === "space"
                      ? `/knowledge/spaces/${f.where.id}`
                      : `/chat/${f.where.id}`
                  }
                  className="hover:text-accent-text"
                >
                  {f.where.kind === "space"
                    ? s.inSpace(f.where.label)
                    : s.inConversation(f.where.label)}
                </Link>
                {" · "}
                {date.format(new Date(f.createdAt))}
              </p>
            </div>
            {f.deletable ? (
              <button
                type="button"
                aria-label={`${s.delete}: ${f.name}`}
                disabled={pending}
                onClick={() => remove(f)}
                className="grid size-10 shrink-0 place-items-center rounded-full text-muted hover:bg-active hover:text-danger-text md:size-8"
              >
                <Trash2 className="size-4" aria-hidden />
              </button>
            ) : (
              <span className="shrink-0 text-[11.5px] text-faint max-sm:hidden">
                {s.withConversation}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
