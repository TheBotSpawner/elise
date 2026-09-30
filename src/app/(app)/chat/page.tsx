import { MessagesSquare, Plus, Search } from "lucide-react";
import Link from "next/link";

import { requireAuthContext } from "@/application/auth-context";
import { listConversations } from "@/application/conversations-service";
import { searchRecall, sessionSummaries } from "@/application/recall-service";
import { EmptyState, PageContainer, PageHeader } from "@/components/shared/page";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DeleteConversationButton } from "@/features/history/delete-conversation";
import { getT } from "@/lib/i18n/server";

/** History is available but not the protagonist: it's one continuous Elise. */
export default async function ChatHistoryPage({ searchParams }: PageProps<"/chat">) {
  const [auth, { t, locale }, params] = await Promise.all([
    requireAuthContext(),
    getT(),
    searchParams,
  ]);
  const query = typeof params.q === "string" ? params.q.trim().slice(0, 200) : "";
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: auth.profile.timezone,
  });

  // Searching goes through Recall (meaning + words); otherwise the latest conversations.
  const rows = query
    ? (await searchRecall(auth, query, null, 20).catch(() => []))
        .filter((r) => r.url)
        .map((r) => ({
          id: r.url!.split("/").at(-1)!,
          title: r.title,
          summary: r.summary ?? r.excerpts[0]?.text ?? null,
          at: r.lastActivity,
        }))
    : await (async () => {
        const conversations = await listConversations(auth);
        const summaries = await sessionSummaries(
          auth,
          conversations.map((c) => c.id),
        );
        return conversations.map((c) => ({
          id: c.id,
          title: c.title || summaries.get(c.id)?.title || null,
          summary: summaries.get(c.id)?.summary ?? null,
          at: c.lastMessageAt,
        }));
      })();

  const newChat = (
    <Link href="/" className={buttonVariants({ size: "sm" })}>
      <Plus />
      {t.chat.newChat}
    </Link>
  );

  return (
    <PageContainer>
      <PageHeader title={t.chat.history} subtitle={t.chat.historySubtitle} actions={newChat} />
      <form role="search" action="/chat" className="relative mb-4">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
          aria-hidden
        />
        <Input
          name="q"
          defaultValue={query}
          placeholder={t.chat.historySearch}
          aria-label={t.chat.historySearch}
          className="pl-9"
        />
      </form>
      {rows.length === 0 ? (
        query ? (
          <p className="px-1 text-[14px] text-muted">{t.chat.historyNoMatches}</p>
        ) : (
          <EmptyState
            icon={MessagesSquare}
            title={t.chat.history}
            body={t.chat.historyEmpty}
            action={newChat}
          />
        )
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center gap-2 pr-2 hover:bg-surface-2">
              <Link
                href={`/chat/${c.id}`}
                className="flex min-w-0 flex-1 items-center justify-between gap-4 py-3 pl-4"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm">{c.title || t.chat.untitled}</span>
                  {c.summary && (
                    <span className="block truncate text-[12.5px] text-faint">{c.summary}</span>
                  )}
                </span>
                <time className="shrink-0 font-mono text-xs text-muted" dateTime={c.at}>
                  {format.format(new Date(c.at))}
                </time>
              </Link>
              <DeleteConversationButton id={c.id} title={c.title || t.chat.untitled} />
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
