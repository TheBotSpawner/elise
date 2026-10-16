"use client";

import type { Chip } from "@/core/history/links";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

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
