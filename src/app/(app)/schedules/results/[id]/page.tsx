import { notFound } from "next/navigation";

import { requireAuthContext } from "@/application/auth-context";
import { getResult } from "@/application/schedules-service";
import { PageContainer } from "@/components/shared/page";
import { BriefView } from "@/features/schedules/brief-view";

/** A stored scheduled result (e.g. a Morning Brief). Old briefs stay available here. */
export default async function ResultPage({ params }: PageProps<"/schedules/results/[id]">) {
  const [auth, { id }] = await Promise.all([requireAuthContext(), params]);
  const result = await getResult(auth, id).catch(() => null);
  if (!result) notFound();
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
