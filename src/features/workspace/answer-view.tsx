"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { SurfacePayloads } from "@/core/workspace/registry";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

type Answer = SurfacePayloads["answer"];
type Item = Answer["items"][number];

/** Rows shown before "Ver todos": a compact answer fits without scrolling. */
const LIMIT = 8;

/**
 * The answer Surface (ADR-071): what the user asked for, as structure — voice explains, the
 * screen organizes. Badges are words (never color alone); sources sit behind "Fuentes · N".
 */
export function AnswerBody({ p, large }: { p: Answer; large: boolean }) {
  const { t } = useI18n();
  const a = t.workspace.answer;
  const [all, setAll] = useState(false);
  const items = all ? p.items : p.items.slice(0, LIMIT);
  return (
    <div className="flex flex-col gap-3">
      {p.summary && <p className="text-[13px] leading-[1.5] text-muted">{p.summary}</p>}
      {p.metrics?.length ? <Metrics metrics={p.metrics} /> : null}
      {p.intent === "comparison" && p.columns?.length ? (
        <Comparison items={items} columns={p.columns} large={large} />
      ) : (
        items.length > 0 && <Items items={items} intent={p.intent} />
      )}
      {p.items.length > LIMIT && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="touch-hit self-start text-[12.5px] text-accent-text hover:underline"
        >
          {all ? a.showLess : a.showAll(p.items.length)}
        </button>
      )}
      {p.total !== undefined && p.total > p.items.length && (
        <p className="text-[12px] text-faint">{a.ofTotal(p.items.length, p.total)}</p>
      )}
      <Sources sources={p.sources} />
    </div>
  );
}

function Metrics({ metrics }: { metrics: NonNullable<Answer["metrics"]> }) {
  return (
    <dl className="grid grid-cols-2 gap-2">
      {metrics.map((m) => (
        <div key={m.label} className="rounded-xl border border-border px-3 py-2">
          <dt className="text-[12px] text-muted">{m.label}</dt>
          <dd className="font-mono text-[17px] tabular-nums">{m.value}</dd>
          {m.secondary && <dd className="text-[12px] text-faint">{m.secondary}</dd>}
        </div>
      ))}
    </dl>
  );
}

function Items({ items, intent }: { items: Item[]; intent: Answer["intent"] }) {
  // Groups in the order the answer gives them ("Competidor directo", then "Referentes").
  const groups = [...new Set(items.map((i) => i.group ?? ""))];
  const List = intent === "ranking" ? "ol" : "ul";
  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <section key={g || "_"} className="flex flex-col">
          {g && <h3 className="pb-1 type-label text-faint">{g}</h3>}
          <List className="flex flex-col divide-y divide-border">
            {items
              .filter((i) => (i.group ?? "") === g)
              .map((i, n) => (
                <Row key={`${i.title}-${n}`} item={i} checklist={intent === "checklist"} />
              ))}
          </List>
        </section>
      ))}
    </div>
  );
}

function Row({ item: i, checklist }: { item: Item; checklist: boolean }) {
  return (
    <li className="flex items-start gap-3 py-2">
      {i.rank !== undefined ? (
        <span className="w-6 shrink-0 pt-px text-right font-mono text-[12.5px] text-faint tabular-nums">
          {i.rank}
        </span>
      ) : checklist ? (
        <span
          aria-hidden
          className="mt-1 size-3.5 shrink-0 rounded-full border border-border-strong"
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[14px] font-medium">{i.title}</span>
          {i.badge && <Badge>{i.badge}</Badge>}
        </div>
        {i.description && (
          <p className="text-[12.5px] leading-[1.45] text-muted">
            {i.description}
            <Refs refs={i.sources} />
          </p>
        )}
      </div>
      {i.value && (
        <span className="shrink-0 font-mono text-[13px] tabular-nums">
          {i.value}
          {!i.description && <Refs refs={i.sources} />}
        </span>
      )}
    </li>
  );
}

const Badge = ({ children }: { children: string }) => (
  <span className="rounded-full border border-border px-2 py-px text-[10.5px] font-medium tracking-wide text-muted uppercase">
    {children}
  </span>
);

/** Which sources an item came from, as quiet numbers matching the sources list. */
function Refs({ refs }: { refs: number[] }) {
  const { t } = useI18n();
  if (!refs.length) return null;
  return (
    <sup
      className="ml-1 font-mono text-[10px] text-faint"
      aria-label={`${t.workspace.answer.sources(refs.length)}: ${refs.map((r) => r + 1).join(", ")}`}
    >
      {refs.map((r) => r + 1).join("·")}
    </sup>
  );
}

/** A table only with room for it; narrow canvases and phones get one card per option. */
function Comparison({
  items,
  columns,
  large,
}: {
  items: Item[];
  columns: NonNullable<Answer["columns"]>;
  large: boolean;
}) {
  const cards = (
    <ul className={cn("flex flex-col gap-2", large && "sm:hidden")}>
      {items.map((i, n) => (
        <li key={`${i.title}-${n}`} className="rounded-xl border border-border px-3 py-2">
          <p className="text-[14px] font-medium">
            {i.title}
            <Refs refs={i.sources} />
          </p>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px]">
            {columns.map((c) => (
              <div key={c.key} className="contents">
                <dt className="text-muted">{c.label}</dt>
                <dd>{i.cells?.[c.key] ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
  if (!large) return cards;
  return (
    <>
      <table className="w-full text-left text-[13px] max-sm:hidden">
        <thead>
          <tr className="border-b border-border text-[12px] text-muted">
            <th scope="col" className="py-1.5 pr-3 font-normal" />
            {columns.map((c) => (
              <th key={c.key} scope="col" className="py-1.5 pr-3 font-normal">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((i, n) => (
            <tr key={`${i.title}-${n}`}>
              <th scope="row" className="py-2 pr-3 font-medium">
                {i.title}
                <Refs refs={i.sources} />
              </th>
              {columns.map((c) => (
                <td key={c.key} className="py-2 pr-3 align-top">
                  {i.cells?.[c.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {cards}
    </>
  );
}

/** Provenance, collapsed: what the answer came from, each one openable. */
function Sources({ sources }: { sources: Answer["sources"] }) {
  const { t } = useI18n();
  const a = t.workspace.answer;
  if (!sources.length) return null;
  return (
    <details className="group border-t border-border pt-2">
      <summary className="touch-hit inline-flex cursor-pointer list-none items-center gap-1 text-[12.5px] text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
        {a.sources(sources.length)}
        <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <ol className="mt-1.5 flex flex-col gap-1">
        {sources.map((s, n) => {
          const label = (
            <>
              <span className="font-mono text-[11px] text-faint">{n + 1}</span>
              <span className="min-w-0 truncate">{s.title}</span>
              <span className="shrink-0 text-[11.5px] text-faint">
                {s.space ?? a.sourceKinds[s.kind]}
              </span>
            </>
          );
          const cls = "flex items-baseline gap-2 text-[12.5px]";
          return (
            <li key={`${s.title}-${n}`}>
              {s.url?.startsWith("/") ? (
                <Link href={s.url} className={cn(cls, "hover:text-accent-text")}>
                  {label}
                </Link>
              ) : s.url ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className={cn(cls, "hover:text-accent-text")}
                >
                  {label}
                </a>
              ) : (
                <span className={cls}>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
