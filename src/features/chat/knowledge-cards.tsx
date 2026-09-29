"use client";

import { motion, type MotionProps } from "motion/react";
import Link from "next/link";

import type { ToolDisplay } from "@/core/agents/tools";
import { useI18n } from "@/lib/i18n/client";

type Evidence = Extract<ToolDisplay, { kind: "knowledge_evidence" }>;

/**
 * The sources behind a Knowledge answer, numbered like the citations [n] in the text. Each one
 * opens the cited passage with its document, version and a way to the original.
 */
export function KnowledgeSourcesCard({ display, rise }: { display: Evidence; rise: MotionProps }) {
  const { t } = useI18n();
  return (
    <motion.section
      {...rise}
      aria-label={t.knowledge.sourcesCard}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-surface px-4 py-3.5 md:px-5 md:py-[18px]"
    >
      <span className="type-label text-faint">
        {t.knowledge.sourcesCard} · {display.scope.join(", ")}
      </span>
      {!display.enough ? (
        <p className="text-[14px] text-muted">{t.knowledge.notEnough}</p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {display.evidence.map((e) => (
            <li key={e.chunkId} className="grid grid-cols-[28px_minmax(0,1fr)] gap-2 text-[14px]">
              <span className="font-mono text-[12.5px] text-accent-text">[{e.ref}]</span>
              <Link
                href={`/knowledge/items/${e.itemId}?chunk=${e.chunkId}`}
                className="min-w-0 hover:text-accent-text"
              >
                <span className="block truncate">
                  {e.title}
                  <span className="text-muted">
                    {e.page
                      ? ` · ${t.knowledge.item.page(e.page)}`
                      : e.section
                        ? ` · ${e.section}`
                        : ""}
                  </span>
                </span>
                <span className="block truncate text-[12.5px] text-faint">
                  {t.knowledge.sourceTypes[e.sourceType as keyof typeof t.knowledge.sourceTypes] ??
                    e.sourceType}
                  {e.versionNumber > 1 && ` · v${e.versionNumber}`} · {e.snippet}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </motion.section>
  );
}
