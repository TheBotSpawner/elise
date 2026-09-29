import { MessagesSquare, Plus } from "lucide-react";
import Link from "next/link";

import { requireAuthContext } from "@/application/auth-context";
import { listConversations } from "@/application/conversations-service";
import { EmptyState, PageContainer, PageHeader } from "@/components/shared/page";
import { buttonVariants } from "@/components/ui/button";
import { getT } from "@/lib/i18n/server";

/** History is available but not the protagonist: it's one continuous Elise. */
export default async function ChatHistoryPage() {
  const [auth, { t, locale }] = await Promise.all([requireAuthContext(), getT()]);
  const conversations = await listConversations(auth);
  const format = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: auth.profile.timezone,
  });

  const newChat = (
    <Link href="/" className={buttonVariants({ size: "sm" })}>
      <Plus />
      {t.chat.newChat}
    </Link>
  );

  return (
    <PageContainer>
      <PageHeader title={t.chat.history} actions={newChat} />
      {conversations.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title={t.chat.history}
          body={t.chat.historyEmpty}
          action={newChat}
        />
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-surface">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href={`/chat/${c.id}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-surface-2"
              >
                <span className="truncate text-sm">{c.title || t.chat.untitled}</span>
                <time className="shrink-0 font-mono text-xs text-muted" dateTime={c.lastMessageAt}>
                  {format.format(new Date(c.lastMessageAt))}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
