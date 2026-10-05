import { z } from "zod";

import { requireAuthContext } from "@/application/auth-context";
import { knowledgeItemText, listMethodCards, methodDetail } from "@/application/methods-service";
import { PageContainer, PageHeader } from "@/components/shared/page";
import { parseSkillMarkdown } from "@/core/skills/markdown";
import { MethodsPanel, type MethodDraftInput } from "@/features/methods/methods-panel";
import { getT } from "@/lib/i18n/server";

/**
 * Every Method (ADR-040 §K): general ones and each Space's, in one place. `?method=` opens one
 * (the "View" of a chat confirmation); `?fromItem=` starts one from a Knowledge document.
 */
export default async function MethodsPage({ searchParams }: PageProps<"/my-elise/methods">) {
  const [{ method, fromItem }, auth, { t }] = await Promise.all([
    searchParams,
    requireAuthContext(),
    getT(),
  ]);
  const uuid = (v: unknown) => (z.uuid().safeParse(v).success ? (v as string) : null);
  const itemId = uuid(fromItem);
  const openId = uuid(method);
  const [{ methods, spaces }, doc, opened] = await Promise.all([
    listMethodCards(auth),
    itemId ? knowledgeItemText(auth, itemId).catch(() => null) : null,
    openId ? methodDetail(auth, openId).catch(() => null) : null,
  ]);
  let draft: MethodDraftInput | null = null;
  if (doc?.text.trim()) {
    const parsed = parseSkillMarkdown(doc.text, doc.title);
    draft = {
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      hints: parsed.hints.join(", "),
      spaceId: doc.spaceId,
      itemId: itemId!,
    };
  }
  return (
    <PageContainer>
      <PageHeader title={t.methods.title} subtitle={t.methods.subtitle} />
      <MethodsPanel
        methods={methods}
        spaces={spaces}
        opened={opened}
        initialDraft={draft}
        heading={false}
      />
    </PageContainer>
  );
}
