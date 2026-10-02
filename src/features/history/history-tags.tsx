"use client";

import { Tag } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Dialog } from "@/components/ui/dialog";
import type { Chip, KnowledgeNode } from "@/core/history/links";
import type { ThreadRef } from "@/core/interaction";
import { errorText } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { setThreadLinkAction } from "./actions";

const VISIBLE = 2;

/** A row's Space/Section tags: the first two, then "+N" that names the rest. */
export function TagChips({ chips }: { chips: Chip[] }) {
  const { t } = useI18n();
  if (!chips.length) return null;
  const shown = chips.slice(0, VISIBLE);
  const rest = chips.slice(VISIBLE);
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1">
      {shown.map((c) => (
        <span
          key={c.id}
          className={cn(
            "inline-flex h-5 max-w-[160px] items-center truncate rounded-full border border-border px-2 text-[11.5px] text-muted",
            c.archived && "border-dashed text-faint",
          )}
        >
          <span className="truncate">{c.label}</span>
          {c.archived && <span className="sr-only"> ({t.history.archived})</span>}
        </span>
      ))}
      {rest.length > 0 && (
        <span
          className="inline-flex h-5 items-center rounded-full px-1.5 text-[11.5px] text-faint"
          aria-label={rest.map((c) => c.label).join(", ")}
          title={rest.map((c) => c.label).join(", ")}
        >
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/**
 * "Tags": which Spaces and Sections this conversation belongs to. Each change is saved at
 * once and stays — ELISE's automatic tags never override what the user set here.
 */
export function TagEditor({
  thread,
  title,
  linked,
  nodes,
}: {
  thread: ThreadRef;
  title: string;
  linked: string[];
  nodes: KnowledgeNode[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(() => new Set(linked));
  const [pending, startTransition] = useTransition();
  const spaces = nodes.filter((n) => !n.parentId && !n.archived);
  const toggle = (id: string) => {
    const linkedNow = !on.has(id);
    const next = new Set(on);
    if (linkedNow) next.add(id);
    else next.delete(id);
    setOn(next);
    startTransition(async () => {
      const r = await setThreadLinkAction({
        kind: thread.kind,
        id: thread.id,
        spaceId: id,
        linked: linkedNow,
      });
      if (!r.ok) {
        // Saving failed: show the real state again.
        setOn(new Set(on));
        toast.error(errorText(t, r.error));
      } else router.refresh();
    });
  };

  return (
    <>
      <button
        type="button"
        aria-label={t.history.tagsFor(title)}
        onClick={() => {
          setOn(new Set(linked));
          setOpen(true);
        }}
        className="grid size-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:text-fg"
      >
        <Tag className="size-4" aria-hidden />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t.history.tagsTitle}
        description={t.history.tagsBody}
      >
        {spaces.length === 0 ? (
          <p className="text-[14px] text-muted">{t.history.noSpaces}</p>
        ) : (
          <ul className="flex max-h-[60dvh] flex-col gap-3 overflow-y-auto">
            {spaces.map((s) => {
              const sections = nodes.filter((n) => n.parentId === s.id && !n.archived);
              return (
                <li key={s.id}>
                  <TagOption
                    label={s.name}
                    checked={on.has(s.id)}
                    disabled={pending}
                    onChange={() => toggle(s.id)}
                  />
                  {sections.length > 0 && (
                    <ul className="mt-1 ml-6 flex flex-col gap-1">
                      {sections.map((c) => (
                        <li key={c.id}>
                          <TagOption
                            label={c.name}
                            checked={on.has(c.id)}
                            disabled={pending}
                            onChange={() => toggle(c.id)}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
    </>
  );
}

function TagOption({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 text-[14px] hover:bg-active">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="size-4 accent-[var(--color-accent)]"
      />
      {label}
    </label>
  );
}
