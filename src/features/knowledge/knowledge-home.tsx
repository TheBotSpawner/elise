"use client";

import { BookOpen, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { SpaceSummary } from "@/application/knowledge-service";
import { EmptyState } from "@/components/shared/page";
import { Button } from "@/components/ui/button";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

import { SpaceGlyph } from "./appearance";
import { CreateSpaceDialog } from "./space-dialogs";
import { SourceIcon, useRelative } from "./ui";

function SpaceCard({ space, subspaces }: { space: SpaceSummary; subspaces: SpaceSummary[] }) {
  const { t } = useI18n();
  const relative = useRelative();
  // Logical sources (ADR-037): a Notion database is one, however many pages it holds.
  const c = space.sources;
  const dot = c.attention ? "bg-approval" : c.processing ? "bg-accent animate-pulse" : "bg-success";
  return (
    <li className="group relative flex flex-col gap-3 rounded-2xl border border-border bg-surface px-5 py-4 transition-colors hover:border-border-strong">
      <div className="flex items-start gap-3">
        <SpaceGlyph icon={space.icon} color={space.color} />
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`/knowledge/spaces/${space.id}`}
            className="text-base font-medium group-hover:text-accent-text after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none after:focus-visible:ring-2 after:focus-visible:ring-accent"
          >
            {space.name}
          </Link>
          {space.description && (
            <p className="line-clamp-2 text-[13.5px] text-muted">{space.description}</p>
          )}
        </div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-faint">
        {space.sourceTypes.length > 0 && (
          <span className="flex items-center gap-1.5" aria-hidden>
            {space.sourceTypes.map((type) => (
              <SourceIcon key={type} type={type} size={14} />
            ))}
          </span>
        )}
        <span className="flex items-center gap-1.5">
          {c.total > 0 && <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />}
          {c.total > 0
            ? t.knowledge.sourceSummary(c.total, c.processing, 0)
            : t.knowledge.counts(0, 0, 0)}
          {c.attention > 0 && (
            <>
              {" · "}
              {/* Above the card's stretched link: opens what needs attention. */}
              <Link
                href={`/knowledge/spaces/${space.id}?attention=1`}
                className="relative z-10 text-approval-text underline-offset-2 hover:underline"
              >
                {t.knowledge.attentionCount(c.attention)}
              </Link>
            </>
          )}
        </span>
        {space.updatedAt && <span>{t.knowledge.updated(relative(space.updatedAt))}</span>}
      </div>
      {subspaces.length > 0 && (
        <ul className="relative flex flex-wrap gap-1.5">
          {subspaces.map((child) => (
            <li key={child.id}>
              <Link
                href={`/knowledge/spaces/${child.id}`}
                className="flex h-8 items-center gap-1.5 rounded-full bg-surface-2 pr-3 pl-1.5 text-[13px] text-muted hover:text-fg"
              >
                <SpaceGlyph
                  icon={child.icon}
                  color={child.color}
                  size="sm"
                  className="rounded-full"
                />
                {child.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Spaces first: Knowledge is contexts the user thinks in, not a file manager. */
export function KnowledgeHome({
  spaces,
  workspaceId,
  backgroundAvailable,
  notionAvailable,
}: {
  spaces: SpaceSummary[];
  workspaceId: string;
  backgroundAvailable: boolean;
  notionAvailable: boolean;
}) {
  const { t } = useI18n();
  // null = closed; otherwise the name the dialog starts from.
  const [creating, setCreating] = useState<string | null>(null);
  useRealtimeRefresh(workspaceId, ["knowledge_spaces", "knowledge_items", "knowledge_sources"]);
  const top = spaces.filter((s) => !s.parentId);
  const childrenOf = (id: string) => spaces.filter((s) => s.parentId === id);
  // General Knowledge always exists (ADR-047); the first-run invitation is about the user's own.
  const general = top.find((s) => s.general);

  return (
    <div className="flex flex-col gap-4">
      {!backgroundAvailable && (
        <p className="rounded-2xl border border-dashed border-border px-5 py-3.5 text-[13.5px] text-muted">
          {t.knowledge.background}
        </p>
      )}
      {top.every((s) => s.general) && general && (
        <ul className="grid gap-3 sm:grid-cols-2">
          <SpaceCard space={general} subspaces={childrenOf(general.id)} />
        </ul>
      )}
      {top.every((s) => s.general) ? (
        <EmptyState
          icon={BookOpen}
          title={t.knowledge.emptyTitle}
          body={t.knowledge.emptyBody}
          action={
            <div className="flex flex-col items-center gap-4">
              <Button size="lg" onClick={() => setCreating("")}>
                <Plus />
                {t.knowledge.createFirst}
              </Button>
              <ul className="flex flex-wrap justify-center gap-1.5">
                {t.knowledge.starterExamples.map((example) => (
                  <li key={example}>
                    <button
                      type="button"
                      onClick={() => setCreating(example)}
                      className="h-8 rounded-full bg-surface-2 px-3 text-[13px] text-muted transition-colors hover:text-fg"
                    >
                      {example}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          }
        />
      ) : (
        <>
          <p className="text-[13.5px] text-muted">{t.knowledge.helper}</p>
          <ul className="grid gap-3 sm:grid-cols-2">
            {top.map((s) => (
              <SpaceCard key={s.id} space={s} subspaces={childrenOf(s.id)} />
            ))}
            <li>
              <button
                type="button"
                onClick={() => setCreating("")}
                className="flex h-full min-h-28 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-sm text-muted transition-colors hover:border-border-strong hover:text-fg"
              >
                <Plus className="size-4" aria-hidden />
                {t.knowledge.newSpace}
              </button>
            </li>
          </ul>
        </>
      )}
      <CreateSpaceDialog
        open={creating !== null}
        initialName={creating ?? ""}
        onClose={() => setCreating(null)}
        notionAvailable={notionAvailable}
      />
    </div>
  );
}
