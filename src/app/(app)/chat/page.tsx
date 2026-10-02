import { MessagesSquare, Mic, Plus, Search } from "lucide-react";
import Link from "next/link";

import { requireAuthContext } from "@/application/auth-context";
import { historyRows, type HistoryRow } from "@/application/history-service";
import { EmptyState, PageContainer, PageHeader } from "@/components/shared/page";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { groupThreads, type HistoryFilter, type KnowledgeNode } from "@/core/history/links";
import { DeleteConversationButton } from "@/features/history/delete-conversation";
import { HistoryControls, type HistoryParams } from "@/features/history/history-controls";
import { TagChips, TagEditor } from "@/features/history/history-tags";
import type { Dictionary } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * History (ADR-020): typed and voice conversations, organized by the same Spaces and Sections
 * as Knowledge — tags on each row, a Space/Section filter, search that also matches tags, and
 * optional grouping. Chronological by default.
 */
export default async function ChatHistoryPage({ searchParams }: PageProps<"/chat">) {
  const [auth, { t, locale }, raw] = await Promise.all([
    requireAuthContext(),
    getT(),
    searchParams,
  ]);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const params: HistoryParams = {
    q: str(raw.q).trim().slice(0, 200),
    space: str(raw.space) === "untagged" || UUID.test(str(raw.space)) ? str(raw.space) : null,
    section: UUID.test(str(raw.section)) ? str(raw.section) : null,
    group:
      str(raw.group) === "space" || str(raw.group) === "section"
        ? (str(raw.group) as "space" | "section")
        : "none",
    sort: str(raw.sort) === "oldest" ? "oldest" : "newest",
  };
  const filter: HistoryFilter =
    params.space === "untagged"
      ? { kind: "untagged" }
      : params.space
        ? { kind: "space", spaceId: params.space, sectionId: params.section }
        : { kind: "all" };
  const { rows, nodes } = await historyRows(auth, { q: params.q, filter, sort: params.sort });
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: auth.profile.timezone,
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const filtered = params.q || filter.kind !== "all";

  const newChat = (
    <Link href="/" className={buttonVariants({ size: "sm" })}>
      <Plus />
      {t.chat.newChat}
    </Link>
  );

  const list = (items: HistoryRow[]) => (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
      {items.map((r) => (
        <Row key={r.key} row={r} t={t} nodes={nodes} when={format.format(new Date(r.at))} />
      ))}
    </ul>
  );

  return (
    <PageContainer>
      <PageHeader title={t.chat.history} subtitle={t.chat.historySubtitle} actions={newChat} />
      <form role="search" action="/chat" className="relative mb-4">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
          aria-hidden
        />
        {params.space && <input type="hidden" name="space" value={params.space} />}
        {params.section && <input type="hidden" name="section" value={params.section} />}
        {params.group !== "none" && <input type="hidden" name="group" value={params.group} />}
        <Input
          name="q"
          defaultValue={params.q}
          placeholder={t.history.search}
          aria-label={t.history.search}
          className="pl-9"
        />
      </form>
      <HistoryControls params={params} nodes={nodes} />

      {rows.length === 0 ? (
        filtered ? (
          <p className="px-1 text-[14px] text-muted">{t.chat.historyNoMatches}</p>
        ) : (
          <EmptyState
            icon={MessagesSquare}
            title={t.chat.history}
            body={t.chat.historyEmpty}
            action={newChat}
          />
        )
      ) : params.group === "none" ? (
        list(rows)
      ) : (
        <div className="flex flex-col gap-4">
          {groupThreads(rows, params.group, byId, t.history.untagged, t.history.general).map(
            (g) => (
              <details key={g.key} open className="group">
                <summary className="mb-2 flex cursor-pointer list-none items-baseline gap-2 px-1 [&::-webkit-details-marker]:hidden">
                  {g.parentLabel && params.group === "section" && (
                    <span className="type-label text-faint">{g.parentLabel} ›</span>
                  )}
                  <span className="type-label text-muted">{g.label}</span>
                  {g.archived && (
                    <span className="text-[12px] text-faint">· {t.history.archived}</span>
                  )}
                  <span className="text-[12px] text-faint">{g.items.length}</span>
                </summary>
                {list(g.items)}
              </details>
            ),
          )}
        </div>
      )}
    </PageContainer>
  );
}

function Row({
  row: r,
  t,
  nodes,
  when,
}: {
  row: HistoryRow;
  t: Dictionary;
  nodes: KnowledgeNode[];
  when: string;
}) {
  const title = r.title || (r.voice ? t.voice.historyItem : t.chat.untitled);
  const href =
    r.thread.kind === "conversation" ? `/chat/${r.thread.id}` : `/?session=${r.thread.id}`;
  return (
    <li className="flex items-center gap-1 pr-2 hover:bg-surface-2">
      <Link
        href={href}
        className="flex min-w-0 flex-1 items-center justify-between gap-4 py-3 pl-4"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm">
            {r.voice && (
              <Mic className="size-3.5 shrink-0 text-faint" aria-label={t.voice.history} />
            )}
            <span className="truncate">{title}</span>
          </span>
          {r.summary && (
            <span className="block truncate text-[12.5px] text-faint">{r.summary}</span>
          )}
          <TagChips chips={r.chips} />
        </span>
        <time className="shrink-0 font-mono text-xs text-muted" dateTime={r.at}>
          {when}
        </time>
      </Link>
      <TagEditor thread={r.thread} title={title} linked={r.spaceIds} nodes={nodes} />
      <DeleteConversationButton id={r.thread.id} title={title} voice={r.voice} />
    </li>
  );
}
