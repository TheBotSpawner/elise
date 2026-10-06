import { CalendarClock, MessagesSquare, Mic, Search } from "lucide-react";
import Link from "next/link";
import { after } from "next/server";

import { requireAuthContext } from "@/application/auth-context";
import { autoLinkThread } from "@/application/history-links-service";
import { historyRows, type HistoryRow } from "@/application/history-service";
import { EmptyState, PageContainer, PageHeader } from "@/components/shared/page";
import { Input } from "@/components/ui/input";
import {
  groupThreads,
  historyFolders,
  locationOf,
  recentThreads,
  relativeWhen,
  RECENTS_LIMIT,
  type HistoryFilter,
  type KnowledgeNode,
} from "@/core/history/links";
import { NewChatButton } from "@/features/chat/continuity";
import { DeleteConversationButton } from "@/features/history/delete-conversation";
import { HistoryControls, type HistoryParams } from "@/features/history/history-controls";
import { HistoryFolder } from "@/features/history/history-folder";
import { TagChips, TagEditor } from "@/features/history/history-tags";
import type { Dictionary } from "@/lib/i18n";
import { getT } from "@/lib/i18n/server";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * History (ADR-020): typed and voice conversations, organized by the same Spaces and Sections
 * as Knowledge. By default it reads as folders, Space > Section > conversations, plus the
 * untagged ones; each conversation is filed once under its primary link (other links stay as
 * chips). Search is global and flat, each result showing where it is filed. A flat list and
 * Section groups remain a choice.
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
    // Folders (Space › Section) are the default; a flat list or Section groups are a choice.
    group:
      str(raw.group) === "none" || str(raw.group) === "section"
        ? (str(raw.group) as "none" | "section")
        : "space",
    sort: str(raw.sort) === "oldest" ? "oldest" : "newest",
  };
  const filter: HistoryFilter =
    params.space === "untagged"
      ? { kind: "untagged" }
      : params.space
        ? { kind: "space", spaceId: params.space, sectionId: params.section }
        : { kind: "all" };
  const { rows, nodes, untaggedRecent } = await historyRows(auth, {
    q: params.q,
    filter,
    sort: params.sort,
  });
  // Never delays the page: tags appear on the next visit.
  if (untaggedRecent.length)
    after(() => Promise.all(untaggedRecent.map((t) => autoLinkThread(auth, t))));
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: auth.profile.timezone,
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const filtered = params.q || filter.kind !== "all";
  const now = new Date();

  const newChat = <NewChatButton />;

  const list = (items: HistoryRow[], located = false) => (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
      {items.map((r) => (
        <Row
          key={r.key}
          row={r}
          t={t}
          nodes={nodes}
          when={format.format(new Date(r.at))}
          location={located ? (locationOf(r.primary, byId) ?? t.history.untagged) : null}
        />
      ))}
    </ul>
  );
  const day = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: auth.profile.timezone,
  });
  const folders = () => {
    const tree = historyFolders(rows, byId);
    const h = t.history;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {tree.spaces.map((f) => (
          <HistoryFolder
            key={f.id}
            id={`space:${f.id}`}
            label={f.archived ? `${f.label} · ${h.archived}` : f.label}
            count={f.count}
            meta={[
              f.sections.length ? h.sectionsCount(f.sections.length) : null,
              day.format(new Date(f.lastAt)),
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            {f.sections.length ? (
              <div className="flex flex-col gap-0.5">
                {f.sections.map((sec) => (
                  <HistoryFolder
                    key={sec.id}
                    id={`section:${sec.id}`}
                    label={sec.archived ? `${sec.label} · ${h.archived}` : sec.label}
                    count={sec.items.length}
                    nested
                  >
                    {list(sec.items)}
                  </HistoryFolder>
                ))}
                {f.general.length > 0 && (
                  <HistoryFolder
                    id={`general:${f.id}`}
                    label={h.generalFolder}
                    count={f.general.length}
                    nested
                  >
                    {list(f.general)}
                  </HistoryFolder>
                )}
              </div>
            ) : (
              list(f.general)
            )}
          </HistoryFolder>
        ))}
        {tree.untagged.length > 0 && (
          <HistoryFolder
            id="untagged"
            label={h.untagged}
            count={tree.untagged.length}
            meta={day.format(new Date(tree.untagged[0]!.at))}
          >
            {list(tree.untagged)}
          </HistoryFolder>
        )}
      </div>
    );
  };

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
        {params.group !== "space" && <input type="hidden" name="group" value={params.group} />}
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
      ) : params.q ? (
        // Search ignores folders: every match, with where it is filed.
        list(rows, true)
      ) : params.group === "space" ? (
        // Default: where conversations belong (folders), then what was just worked on.
        <div className="flex flex-col gap-8">
          <section aria-labelledby="history-spaces" className="flex flex-col gap-2">
            <h2 id="history-spaces" className="px-1 type-label text-faint">
              {t.history.spaces}
            </h2>
            {folders()}
          </section>
          <Recents
            rows={recentThreads(rows)}
            more={rows.length > RECENTS_LIMIT ? moreHref(params) : null}
            title={
              filter.kind === "all"
                ? t.history.recents
                : t.history.recentsIn(
                    filter.kind === "untagged"
                      ? t.history.untagged
                      : (locationOf(filter.sectionId ?? filter.spaceId, byId) ?? t.history.recents),
                  )
            }
            where={(r) => locationOf(r.primary, byId) ?? t.history.untagged}
            when={(r) => relativeWhen(r.at, now, locale, auth.profile.timezone)}
            t={t}
          />
        </div>
      ) : params.group === "none" ? (
        list(rows)
      ) : (
        <div className="flex flex-col gap-4">
          {groupThreads(rows, "section", byId, t.history.untagged, t.history.general).map((g) => (
            <details key={g.key} open className="group">
              <summary className="mb-2 flex cursor-pointer list-none items-baseline gap-2 px-1 [&::-webkit-details-marker]:hidden">
                {g.parentLabel && <span className="type-label text-faint">{g.parentLabel} ›</span>}
                <span className="type-label text-muted">{g.label}</span>
                {g.archived && (
                  <span className="text-[12px] text-faint">· {t.history.archived}</span>
                )}
                <span className="text-[12px] text-faint">{g.items.length}</span>
              </summary>
              {list(g.items)}
            </details>
          ))}
        </div>
      )}
    </PageContainer>
  );
}

/** The same filter, as the full flat list ("Ver más"). */
function moreHref(p: HistoryParams) {
  const q = new URLSearchParams({ group: "none" });
  if (p.space) q.set("space", p.space);
  if (p.section) q.set("section", p.section);
  return `/chat?${q}`;
}

/** Recientes: a short flat list across folders — title, where it is, how long ago. */
function Recents({
  rows,
  title,
  more,
  where,
  when,
  t,
}: {
  rows: HistoryRow[];
  title: string;
  more: string | null;
  where: (r: HistoryRow) => string;
  when: (r: HistoryRow) => string;
  t: Dictionary;
}) {
  if (!rows.length) return null;
  return (
    <section aria-labelledby="history-recents" className="flex flex-col gap-2">
      <h2 id="history-recents" className="px-1 type-label text-faint">
        {title}
      </h2>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li key={r.key}>
            <Link
              href={hrefOf(r)}
              className="flex min-w-0 items-center justify-between gap-4 rounded-xl px-3 py-2.5 hover:bg-surface-2"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[14px]">
                  {r.voice && (
                    <Mic className="size-3.5 shrink-0 text-faint" aria-label={t.voice.history} />
                  )}
                  {r.scheduled && (
                    <CalendarClock
                      className="size-3.5 shrink-0 text-faint"
                      aria-label={t.schedules.conversation.tag}
                    />
                  )}
                  <span className="truncate">
                    {r.title || (r.voice ? t.voice.historyItem : t.chat.untitled)}
                  </span>
                </span>
                <span className="block truncate text-[12px] text-muted">{where(r)}</span>
              </span>
              <time className="shrink-0 font-mono text-[11.5px] text-faint" dateTime={r.at}>
                {when(r)}
              </time>
            </Link>
          </li>
        ))}
      </ul>
      {more && (
        <Link href={more} className="self-start px-3 text-[13px] text-accent-text hover:underline">
          {t.history.seeAll}
        </Link>
      )}
    </section>
  );
}

const hrefOf = (r: HistoryRow) =>
  r.thread.kind === "conversation" ? `/chat/${r.thread.id}` : `/?session=${r.thread.id}`;

function Row({
  row: r,
  t,
  nodes,
  when,
  location,
}: {
  row: HistoryRow;
  t: Dictionary;
  nodes: KnowledgeNode[];
  when: string;
  /** Search results say where they are filed ("UTN › AMII"). */
  location: string | null;
}) {
  const title = r.title || (r.voice ? t.voice.historyItem : t.chat.untitled);
  const href = hrefOf(r);
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
            {r.scheduled && (
              <span className="shrink-0 rounded-full border border-border px-1.5 text-[10.5px] text-faint">
                {t.schedules.conversation.tag}
              </span>
            )}
            <span className="truncate">{title}</span>
          </span>
          {location && <span className="block truncate text-[12px] text-muted">{location}</span>}
          {r.summary && (
            <span className="block truncate text-[12.5px] text-faint">{r.summary}</span>
          )}
          {/* In folders the folder is the primary link; the chips show the others. */}
          <TagChips
            chips={location === null ? r.chips.filter((c) => c.id !== r.primary) : r.chips}
          />
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
