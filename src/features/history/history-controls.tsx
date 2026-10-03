"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { Select } from "@/components/ui/input";
import type { KnowledgeNode } from "@/core/history/links";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export interface HistoryParams {
  q: string;
  space: string | null;
  section: string | null;
  group: "none" | "space" | "section";
  sort: "newest" | "oldest";
}

/** Up to this many Spaces show as chips; more become a select. */
const MAX_CHIPS = 5;

function href(p: HistoryParams, patch: Partial<HistoryParams>) {
  const next = { ...p, ...patch };
  const s = new URLSearchParams();
  if (next.q) s.set("q", next.q);
  if (next.space) s.set("space", next.space);
  if (next.section) s.set("section", next.section);
  if (next.group !== "space") s.set("group", next.group);
  if (next.sort !== "newest") s.set("sort", next.sort);
  const qs = s.toString();
  return qs ? `/chat?${qs}` : "/chat";
}

function FilterChip({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={to}
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex h-9 shrink-0 items-center rounded-full border px-3.5 text-[13px] transition-colors",
        active
          ? "border-accent bg-accent-soft text-fg"
          : "border-border text-muted hover:border-border-strong hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}

/**
 * History filters (ADR-020): Space (chips while few, else a select), then its Sections, then
 * Group by and Sort. Plain URLs: shareable, back-button friendly, server-rendered.
 */
export function HistoryControls({
  params,
  nodes,
}: {
  params: HistoryParams;
  nodes: KnowledgeNode[];
}) {
  const { t } = useI18n();
  const h = t.history;
  const router = useRouter();
  const spaces = nodes.filter((n) => !n.parentId && !n.archived);
  const sections = params.space
    ? nodes.filter((n) => n.parentId === params.space && !n.archived)
    : [];
  const allSpace = { space: null, section: null };

  return (
    <div className="mb-4 flex flex-col gap-3">
      {spaces.length > 0 && (
        <nav aria-label={h.filterSpace} className="flex flex-wrap items-center gap-2">
          {spaces.length <= MAX_CHIPS ? (
            <>
              <FilterChip to={href(params, allSpace)} active={!params.space}>
                {h.all}
              </FilterChip>
              {spaces.map((s) => (
                <FilterChip
                  key={s.id}
                  to={href(params, { space: s.id, section: null })}
                  active={params.space === s.id}
                >
                  {s.name}
                </FilterChip>
              ))}
              <FilterChip
                to={href(params, { space: "untagged", section: null })}
                active={params.space === "untagged"}
              >
                {h.untagged}
              </FilterChip>
            </>
          ) : (
            <label className="flex items-center gap-2 text-[13px] text-muted">
              {h.filterSpace}
              <Select
                value={params.space ?? ""}
                className="w-auto"
                onChange={(e) =>
                  router.push(href(params, { space: e.target.value || null, section: null }))
                }
              >
                <option value="">{h.all}</option>
                {spaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                <option value="untagged">{h.untagged}</option>
              </Select>
            </label>
          )}
        </nav>
      )}
      {sections.length > 0 && (
        <nav aria-label={h.filterSection} className="flex flex-wrap items-center gap-2">
          <FilterChip to={href(params, { section: null })} active={!params.section}>
            {h.allSections}
          </FilterChip>
          {sections.map((c) => (
            <FilterChip
              key={c.id}
              to={href(params, { section: c.id })}
              active={params.section === c.id}
            >
              {c.name}
            </FilterChip>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-center gap-4 text-[13px] text-muted">
        {spaces.length > 0 && (
          <label className="flex items-center gap-2">
            {h.groupBy}
            <Select
              value={params.group}
              className="h-9 w-auto"
              onChange={(e) =>
                router.push(href(params, { group: e.target.value as HistoryParams["group"] }))
              }
            >
              <option value="space">{h.groups.space}</option>
              <option value="section">{h.groups.section}</option>
              <option value="none">{h.groups.none}</option>
            </Select>
          </label>
        )}
        <label className="flex items-center gap-2">
          {h.sortBy}
          <Select
            value={params.sort}
            className="h-9 w-auto"
            onChange={(e) =>
              router.push(href(params, { sort: e.target.value as HistoryParams["sort"] }))
            }
          >
            <option value="newest">{h.sorts.newest}</option>
            <option value="oldest">{h.sorts.oldest}</option>
          </Select>
        </label>
      </div>
    </div>
  );
}
