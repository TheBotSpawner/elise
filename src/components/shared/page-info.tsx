"use client";

import { Info } from "lucide-react";
import { useState } from "react";

import { Dialog } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n/client";

/**
 * A small ⓘ next to a section's title: what the section is, in a popup over a blurred page,
 * instead of a permanent subtitle.
 */
export function PageInfo({ title, body }: { title: string; body: string[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={t.common.aboutSection(title)}
        title={t.common.aboutSection(title)}
        onClick={() => setOpen(true)}
        className="grid size-8 shrink-0 place-items-center rounded-full text-faint transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
      >
        <Info className="size-[18px]" strokeWidth={1.75} aria-hidden />
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        className="border-border-strong bg-[var(--overlay-bg)] backdrop:bg-black/30 backdrop:backdrop-blur-md sm:max-w-md"
      >
        <div className="flex flex-col gap-3 text-[14.5px] leading-relaxed text-muted">
          {body.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      </Dialog>
    </>
  );
}
