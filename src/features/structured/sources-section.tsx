import { ChevronRight, Database, Plus } from "lucide-react";
import Link from "next/link";

import type { SourceView } from "@/application/structured-service";
import { buttonVariants } from "@/components/ui/button";
import type { Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const DOT = {
  active: "bg-success",
  needs_attention: "bg-approval",
  paused: "bg-faint",
  archived: "bg-faint",
} as const;

/** Connections → Databases: the Notion databases ELISE understands field by field. */
export function StructuredSourcesSection({
  sources,
  hasNotion,
  t,
}: {
  sources: SourceView[];
  hasNotion: boolean;
  t: Dictionary;
}) {
  const s = t.structured;
  return (
    <section className="mt-10 flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="type-label text-faint">{s.title}</h2>
          <p className="mt-1 max-w-2xl text-[13.5px] text-muted">{s.subtitle}</p>
        </div>
        {hasNotion && (
          <Link
            href="/connections/sources/new"
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <Plus />
            {s.connect}
          </Link>
        )}
      </div>
      {!hasNotion ? (
        <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[13.5px] text-muted">
          {s.needsNotion}
        </p>
      ) : sources.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-5 py-4 text-[13.5px] text-muted">
          {s.none}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {sources.map((src) => (
            <li key={src.id}>
              <Link
                href={`/connections/sources/${src.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-active"
              >
                <Database className="size-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{src.name}</span>
                  <span className="flex items-center gap-2 text-[12.5px] text-muted">
                    Notion · {src.account}
                    <span className={cn("size-1.5 rounded-full", DOT[src.status])} aria-hidden />
                    {s.status[src.status]}
                  </span>
                </span>
                <ChevronRight className="size-4 text-faint" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
