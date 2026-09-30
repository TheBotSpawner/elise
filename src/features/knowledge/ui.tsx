"use client";

import { FileText, NotebookPen, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import type { SourceView } from "@/application/knowledge-service";
import { GoogleDriveIcon, NotionIcon } from "@/components/elise/brand-icons";
import { useI18n } from "@/lib/i18n/client";

export function useRelative() {
  const { locale } = useI18n();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return (iso: string) => {
    const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
    if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
    return rtf.format(Math.round(hours / 24), "day");
  };
}

export function SourceIcon({ type, size = 18 }: { type: SourceView["sourceType"]; size?: number }) {
  if (type === "google_drive") return <GoogleDriveIcon size={size} aria-hidden />;
  if (type === "notion") return <NotionIcon size={size} aria-hidden />;
  const Icon = type === "note" ? NotebookPen : FileText;
  return <Icon style={{ width: size, height: size }} className="text-muted" aria-hidden />;
}

export type SourceChoice = "upload" | "documents" | "drive" | "notion" | "empty";

const ICON: Record<SourceChoice, ReactNode> = {
  upload: <SourceIcon type="upload" />,
  documents: <SourceIcon type="upload" />,
  drive: <SourceIcon type="google_drive" />,
  notion: <SourceIcon type="notion" />,
  empty: <Sparkles className="size-[18px] text-muted" aria-hidden />,
};

/** The ways to add knowledge, in the user's words. Shared by the create wizard and Add source. */
export function SourceOptions({
  choices,
  onPick,
  disabled,
  unavailable = [],
}: {
  choices: SourceChoice[];
  onPick: (choice: SourceChoice) => void;
  disabled?: boolean;
  unavailable?: SourceChoice[];
}) {
  const { t } = useI18n();
  return (
    <ul className="flex flex-col gap-1">
      {choices.map((choice, i) => (
        <li key={choice}>
          <button
            type="button"
            data-autofocus={i === 0 ? "" : undefined}
            disabled={disabled || unavailable.includes(choice)}
            onClick={() => onPick(choice)}
            className="flex w-full items-center gap-4 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-active focus-visible:bg-active focus-visible:outline-none disabled:opacity-50"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-2">
              {ICON[choice]}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[15px] font-medium">{t.knowledge.options[choice].title}</span>
              <span className="text-[13px] text-muted">
                {unavailable.includes(choice)
                  ? t.knowledge.picker.notionNotConfigured
                  : t.knowledge.options[choice].body}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
