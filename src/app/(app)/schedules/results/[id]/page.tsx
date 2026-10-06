import { notFound, redirect } from "next/navigation";

import { requireAuthContext } from "@/application/auth-context";
import { getResult, markResultRead } from "@/application/schedules-service";
import { PageContainer } from "@/components/shared/page";
import { BriefView } from "@/features/schedules/brief-view";

/**
 * A scheduled result's stable link (notifications, Programados, Home). A run is a conversation
 * (ADR-041): its link opens that conversation's Live Canvas. Results from before that keep
 * rendering as they were stored.
 */
export default async function ResultPage({ params }: PageProps<"/schedules/results/[id]">) {
  const [auth, { id }] = await Promise.all([requireAuthContext(), params]);
  const result = await getResult(auth, id).catch(() => null);
  if (!result) notFound();
  if (result.conversationId) {
    if (!result.readAt) await markResultRead(auth, result.id).catch(() => undefined);
    redirect(`/chat/${result.conversationId}`);
  }
  return (
    <PageContainer>
      <div className="mx-auto max-w-[680px]">
        <BriefView
          resultId={result.id}
          brief={result.brief}
          createdAt={result.createdAt}
          unread={result.readAt === null}
          title={result.title}
        />
      </div>
    </PageContainer>
  );
}
