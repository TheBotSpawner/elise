"use client";

import { BookOpen, FolderPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import type { SpaceSummary } from "@/application/knowledge-service";
import { EmptyState } from "@/components/shared/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";
import { useI18n } from "@/lib/i18n/client";

import { createSpaceAction } from "./actions";

/** Inline "new Space" field, used on the Knowledge home and inside a Space. */
export function NewSpaceForm({
  parentId,
  onDone,
}: {
  parentId: string | null;
  onDone: (id: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await createSpaceAction(name, parentId);
          if (!result.ok) toast.error(t.errors.codes[result.error.code]);
          else onDone(result.value);
        });
      }}
    >
      <Input
        autoFocus
        aria-label={t.knowledge.spaceName}
        placeholder={t.knowledge.spacePlaceholder}
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        className="max-w-xs"
      />
      <Button type="submit" disabled={pending || !name.trim()}>
        {t.knowledge.create}
      </Button>
    </form>
  );
}

function SpaceCard({ space, subspaces }: { space: SpaceSummary; subspaces: SpaceSummary[] }) {
  const { t } = useI18n();
  const c = space.counts;
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-border bg-surface px-5 py-4">
      <Link
        href={`/knowledge/spaces/${space.id}`}
        className="group flex items-baseline justify-between gap-3"
      >
        <span className="text-base font-medium group-hover:text-accent-text">{space.name}</span>
        <span className="text-[12.5px] text-faint">
          {t.knowledge.counts(c.ready, c.processing, c.attention)}
        </span>
      </Link>
      {subspaces.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {subspaces.map((child) => (
            <li key={child.id}>
              <Link
                href={`/knowledge/spaces/${child.id}`}
                className="flex h-8 items-center rounded-full border border-border px-3 text-[13px] text-muted hover:text-fg"
              >
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
}: {
  spaces: SpaceSummary[];
  workspaceId: string;
  backgroundAvailable: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  useRealtimeRefresh(workspaceId, ["knowledge_spaces", "knowledge_items"]);
  const top = spaces.filter((s) => !s.parentId);
  const childrenOf = (id: string) => spaces.filter((s) => s.parentId === id);

  return (
    <div className="flex flex-col gap-4">
      {!backgroundAvailable && (
        <p className="rounded-2xl border border-dashed border-border px-5 py-3.5 text-[13.5px] text-muted">
          {t.knowledge.background}
        </p>
      )}
      <div className="flex min-h-10 items-center justify-end">
        {creating ? (
          <NewSpaceForm parentId={null} onDone={(id) => router.push(`/knowledge/spaces/${id}`)} />
        ) : (
          <Button onClick={() => setCreating(true)}>
            <FolderPlus />
            {t.knowledge.newSpace}
          </Button>
        )}
      </div>
      {top.length === 0 ? (
        <EmptyState icon={BookOpen} title={t.knowledge.emptyTitle} body={t.knowledge.emptyBody} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {top.map((s) => (
            <SpaceCard key={s.id} space={s} subspaces={childrenOf(s.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}
