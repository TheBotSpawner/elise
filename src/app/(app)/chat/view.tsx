"use client";

import { Archive, CalendarClock, MessagesSquare, Mic, Pin, Search } from "lucide-react";
import Link from "next/link";

import { SECTION_ICONS } from "@/components/elise/navigation/nav-items";
import { EmptyState, PageContainer, PageHeader } from "@/components/shared/page";
import { Input } from "@/components/ui/input";
import {
  groupThreads,
  historyFolders,
  locationOf,
  recentThreads,
  relativeWhen,
  RECENTS_LIMIT,
} from "@/core/history/links";
import { NewChatButton } from "@/features/chat/continuity";
import { HistoryControls, type HistoryParams } from "@/features/history/history-controls";
import { HistoryFolder } from "@/features/history/history-folder";
import { TagChips } from "@/features/history/history-tags";
import { DropTarget, HistoryOrganizer, ThreadItem, ThreadMenu } from "@/features/history/organize";
import { NoSpaceGlyph, SpaceGlyph } from "@/features/knowledge/appearance";
import type { Dictionary } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

import type { ChatHistoryProps } from "./load";

type HistoryRow = ChatHistoryProps["rows"][number];

/**
 * History (ADR-020): typed and voice conversations, organized by the same Spaces and Sections
 * as Knowledge. By default it reads as folders, Space > Section > conversations, plus the
 * untagged ones; each conversation is filed once under its primary link (other links stay as
 * chips). Search is global and flat, each result showing where it is filed. A flat list and
 * Section groups remain a choice.
 */
export function View({ params, filter, rows, nodes, timezone, now: readAt }: ChatHistoryProps) {
  const { t, locale } = useI18n();
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const filtered = params.q || filter.kind !== "all";
  const now = new Date(readAt);

  const newChat = <NewChatButton />;

  /** `place`: the folder these rows are shown in (a Space id, null: Sin Espacio), or a flat list. */
  const list = (items: HistoryRow[], place: string | null | "list", located = false) => (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
      {items.map((r) => (
        <Row
          key={r.key}
          row={r}
          t={t}
          place={place}
          when={format.format(new Date(r.at))}
          location={located ? (locationOf(r.primary, byId) ?? t.history.untagged) : null}
        />
      ))}
    </ul>
  );
  const day = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: timezone,
  });
  const folders = () => {
    const tree = historyFolders(rows, byId);
    const h = t.history;
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {tree.spaces.map((f) => (
          <DropTarget key={f.id} spaceId={f.id}>
            <HistoryFolder
              id={`space:${f.id}`}
              // The same glyph and accent the Space has in Knowledge.
              icon={
                <SpaceGlyph icon={byId.get(f.id)?.icon} color={byId.get(f.id)?.color} size="sm" />
              }
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
                    <DropTarget key={sec.id} spaceId={sec.id}>
                      <HistoryFolder
                        id={`section:${sec.id}`}
                        label={sec.archived ? `${sec.label} · ${h.archived}` : sec.label}
                        count={sec.items.length}
                        nested
                      >
                        {list(sec.items, sec.id)}
                      </HistoryFolder>
                    </DropTarget>
                  ))}
                  {f.general.length > 0 && (
                    <HistoryFolder
                      id={`general:${f.id}`}
                      label={h.generalFolder}
                      count={f.general.length}
                      nested
                    >
                      {list(f.general, f.id)}
                    </HistoryFolder>
                  )}
                </div>
              ) : (
                list(f.general, f.id)
              )}
            </HistoryFolder>
          </DropTarget>
        ))}
        {tree.untagged.length > 0 && (
          <DropTarget spaceId={null}>
            <HistoryFolder
              id="untagged"
              icon={<NoSpaceGlyph />}
              label={h.untagged}
              count={tree.untagged.length}
              meta={day.format(new Date(tree.untagged[0]!.at))}
            >
              {list(tree.untagged, null)}
            </HistoryFolder>
          </DropTarget>
        )}
      </div>
    );
  };

  return (
    <PageContainer>
      <HistoryOrganizer nodes={nodes}>
        <PageHeader
          title={params.archived ? t.history.archivedView : t.chat.history}
          icon={params.archived ? Archive : SECTION_ICONS.chat}
          info={[t.chat.historySubtitle]}
          actions={newChat}
        />
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

        {params.archived ? (
          rows.length === 0 ? (
            <p className="px-1 text-[14px] text-muted">{t.history.archivedEmpty}</p>
          ) : (
            list(rows, "list", true)
          )
        ) : rows.length === 0 ? (
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
          list(rows, "list", true)
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
                        : (locationOf(filter.sectionId ?? filter.spaceId, byId) ??
                            t.history.recents),
                    )
              }
              where={(r) => locationOf(r.primary, byId) ?? t.history.untagged}
              when={(r) => relativeWhen(r.at, now, locale, timezone)}
              t={t}
            />
          </div>
        ) : params.group === "none" ? (
          list(rows, "list")
        ) : (
          <div className="flex flex-col gap-4">
            {groupThreads(rows, "section", byId, t.history.untagged, t.history.general).map((g) => (
              <details key={g.key} open className="group">
                <summary className="mb-2 flex cursor-pointer list-none items-baseline gap-2 px-1 [&::-webkit-details-marker]:hidden">
                  {g.parentLabel && (
                    <span className="type-label text-faint">{g.parentLabel} ›</span>
                  )}
                  <span className="type-label text-muted">{g.label}</span>
                  {g.archived && (
                    <span className="text-[12px] text-faint">· {t.history.archived}</span>
                  )}
                  <span className="text-[12px] text-faint">{g.items.length}</span>
                </summary>
                {list(g.items, "list")}
              </details>
            ))}
          </div>
        )}
      </HistoryOrganizer>
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
          <ThreadItem
            key={r.key}
            thread={r.thread}
            rowKey={r.key}
            title={titleOf(r, t)}
            place="list"
            className="group flex items-center gap-1 rounded-xl pr-1 hover:bg-surface-2"
          >
            <Link
              href={hrefOf(r)}
              className="flex min-w-0 flex-1 items-center justify-between gap-4 px-3 py-2.5"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[14px]">
                  {r.pinned && (
                    <Pin
                      className="size-3.5 shrink-0 text-accent-text"
                      aria-label={t.history.menu.pinnedLabel}
                    />
                  )}
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
            <ThreadMenu
              thread={r.thread}
              rowKey={r.key}
              title={titleOf(r, t)}
              primary={r.primary}
              pinned={r.pinned}
              archived={r.archived}
            />
          </ThreadItem>
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

const titleOf = (r: HistoryRow, t: Dictionary) =>
  r.title || (r.voice ? t.voice.historyItem : t.chat.untitled);

const hrefOf = (r: HistoryRow) =>
  r.thread.kind === "conversation" ? `/chat/${r.thread.id}` : `/?session=${r.thread.id}`;

function Row({
  row: r,
  t,
  place,
  when,
  location,
}: {
  row: HistoryRow;
  t: Dictionary;
  place: string | null | "list";
  when: string;
  /** Search results say where they are filed ("Facultad › Matemática"). */
  location: string | null;
}) {
  const title = titleOf(r, t);
  const href = hrefOf(r);
  return (
    <ThreadItem
      thread={r.thread}
      rowKey={r.key}
      title={title}
      place={place}
      className="group flex items-center gap-1 pr-2 hover:bg-surface-2"
    >
      <Link
        href={href}
        className="flex min-w-0 flex-1 items-center justify-between gap-4 py-3 pl-4"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 text-sm">
            {r.pinned && (
              <Pin
                className="size-3.5 shrink-0 text-accent-text"
                aria-label={t.history.menu.pinnedLabel}
              />
            )}
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
      <ThreadMenu
        thread={r.thread}
        rowKey={r.key}
        title={title}
        primary={r.primary}
        pinned={r.pinned}
        archived={r.archived}
      />
    </ThreadItem>
  );
}
