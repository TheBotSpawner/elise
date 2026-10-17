"use client";

import { useState } from "react";

import { isSingleEmoji } from "@/core/emoji";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { Button } from "./button";
import { Dialog } from "./dialog";
import { Input } from "./input";

const QUICK = [
  "🛒",
  "🍽️",
  "🏠",
  "🚗",
  "✈️",
  "🎁",
  "💻",
  "🎓",
  "💊",
  "🎮",
  "💳",
  "💸",
  "🧾",
  "🛍️",
  "🍜",
  "📈",
  "🐾",
  "❤️",
];

/**
 * An icon is one emoji (ADR-075): a button that opens a small picker — curated options, plus any
 * emoji pasted or typed from the system keyboard (ZWJ sequences, flags, skin tones). "" = none.
 */
export function EmojiPicker({
  value,
  onChange,
  label,
  placeholder = "•",
  className,
}: {
  value: string;
  onChange: (emoji: string) => void;
  label: string;
  /** Shown faint while there's no icon (e.g. the suggestion from the name). */
  placeholder?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const e = t.common.emoji;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const pick = (emoji: string) => {
    onChange(emoji);
    setOpen(false);
  };
  const typed = draft.trim();
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        onClick={() => {
          setDraft("");
          setOpen(true);
        }}
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-surface text-[18px] hover:border-border-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
          className,
        )}
      >
        {value || <span className="text-faint">{placeholder}</span>}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={label} className="sm:max-w-sm">
        <div className="grid grid-cols-6 gap-1" role="group" aria-label={e.common}>
          {QUICK.map((i) => (
            <button
              key={i}
              type="button"
              aria-pressed={value === i}
              onClick={() => pick(i)}
              className={cn(
                "grid size-11 place-items-center rounded-xl text-[20px]",
                value === i ? "bg-accent-soft ring-1 ring-accent" : "hover:bg-surface-2",
              )}
            >
              {i}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (isSingleEmoji(typed)) pick(typed);
          }}
        >
          <Input
            data-autofocus
            aria-label={e.paste}
            placeholder={e.paste}
            value={draft}
            aria-invalid={Boolean(typed) && !isSingleEmoji(typed)}
            onChange={(ev) => setDraft(ev.target.value)}
            className="h-11 flex-1 text-[16px]"
          />
          <Button type="submit" variant="secondary" disabled={!isSingleEmoji(typed)}>
            {typed && isSingleEmoji(typed) ? typed : e.use}
          </Button>
        </form>
        {typed && !isSingleEmoji(typed) && (
          <p className="text-[12.5px] text-danger-text">{e.invalid}</p>
        )}
        {value && (
          <Button type="button" variant="ghost" className="self-start" onClick={() => pick("")}>
            {e.none}
          </Button>
        )}
      </Dialog>
    </>
  );
}
