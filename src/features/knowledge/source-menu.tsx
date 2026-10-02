"use client";

import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { SourceView } from "@/application/knowledge-service";
import { Dialog } from "@/components/ui/dialog";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

/**
 * A source's secondary actions (•••). Connected sources keep themselves up to date in the
 * background; "Sync now" is only an escape hatch, so it lives here, not on the row.
 */
export function SourceMenu({
  source: s,
  disabled,
  onSyncNow,
  onRemove,
  when,
}: {
  source: SourceView;
  disabled: boolean;
  onSyncNow: () => void;
  onRemove: () => void;
  /** Relative time ("hace 8 min"). */
  when: (iso: string) => string;
}) {
  const { t } = useI18n();
  const k = t.knowledge;
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const external = s.sourceType === "google_drive" || s.sourceType === "notion";

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

  const item = (label: string, onClick: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        onClick();
      }}
      className={
        "flex w-full rounded-xl px-3 py-2 text-left text-[13.5px] hover:bg-surface-2 disabled:opacity-50" +
        (danger ? " hover:text-danger-text" : "")
      }
    >
      {label}
    </button>
  );

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={k.sourceMenu(s.name)}
        onClick={() => setOpen(!open)}
        className="grid size-9 place-items-center rounded-full text-muted transition-colors hover:bg-active hover:text-fg"
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-40 mt-1 flex w-52 flex-col rounded-2xl border border-border bg-[var(--menu-bg)] p-1 shadow-lg backdrop-blur"
        >
          {external && item(k.syncNow, onSyncNow)}
          {external && item(k.details, () => setDetails(true))}
          {item(k.removeSource, onRemove, true)}
        </div>
      )}
      {external && (
        <Dialog open={details} onClose={() => setDetails(false)} title={s.name}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-[14px]">
            <dt className="text-muted">{k.sourceDetails.state}</dt>
            <dd>{k.sourceState[s.state]}</dd>
            <dt className="text-muted">{k.sourceDetails.lastSync}</dt>
            <dd>{s.lastSyncedAt ? when(s.lastSyncedAt) : "—"}</dd>
            <dt className="text-muted">{k.sourceDetails.nextCheck}</dt>
            <dd>{s.nextSyncAt ? when(s.nextSyncAt) : "—"}</dd>
            <dt className="text-muted">{k.sourceDetails.indexed}</dt>
            <dd>
              {s.counts.ready}
              {s.counts.processing > 0 && ` · ${k.sourceDetails.preparing(s.counts.processing)}`}
              {s.counts.attention > 0 && ` · ${k.sourceDetails.unreadable(s.counts.attention)}`}
            </dd>
            {s.state === "needs_attention" && s.lastErrorCode && (
              <>
                <dt className="text-muted">{k.sourceDetails.lastError}</dt>
                <dd>{errorText(t, { code: s.lastErrorCode })}</dd>
              </>
            )}
          </dl>
          {s.state === "needs_attention" && s.counts.ready > 0 && (
            <p className="mt-4 text-[13px] text-muted">{k.sourceDetails.stillAvailable}</p>
          )}
        </Dialog>
      )}
    </div>
  );
}
