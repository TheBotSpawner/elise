import { z } from "zod";

import { knowledgeItemText, listMethodCards, methodDetail } from "@/application/methods-service";
import { parseSkillMarkdown } from "@/core/skills/markdown";
import type { MethodDraftInput } from "@/features/methods/methods-panel";

import type { RouteLoader } from "../../route-contract";

/**
 * Every Method (ADR-040 §K): general ones and each Space's, in one place. `?method=` opens one
 * (the "View" of a chat confirmation); `?fromItem=` starts one from a Knowledge document.
 */
export const load = (async (auth, { search }) => {
  const { method, fromItem } = search;
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
  return { methods, spaces, opened, draft };
}) satisfies RouteLoader<unknown>;

export type MethodsProps = Awaited<ReturnType<typeof load>>;
