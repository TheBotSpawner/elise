import { notFound } from "next/navigation";
import { z } from "zod";

import { getItemPreview } from "@/application/knowledge-service";
import { knowledgeItemText } from "@/application/methods-service";
import { looksProcedural } from "@/core/skills/model";

import { one, type RouteLoader } from "../../../route-contract";

export const load = (async (auth, { params, search }) => {
  const id = params.id ?? "";
  if (!z.uuid().safeParse(id).success) notFound();
  const chunkParam = one(search.chunk);
  const chunk = chunkParam && z.uuid().safeParse(chunkParam).success ? chunkParam : null;
  const data = await getItemPreview(auth, id, chunk).catch(() => null);
  if (!data) notFound();
  const { item, versions, passage } = data;
  // Drive/Notion documents are read live (ADR-046): any text ELISE kept from before is an old
  // copy, so it is neither shown nor offered as a Method — the original is the reference.
  const live = item.sourceType === "google_drive" || item.sourceType === "notion";
  const doc = live ? null : await knowledgeItemText(auth, id).catch(() => null);
  // A document that reads like a procedure can become a Method (ADR-040 §J3) — offered, never
  // assumed: Knowledge stays Knowledge.
  const procedural = Boolean(doc && looksProcedural(doc.text));
  return { item, versions, passage, live, procedural, timezone: auth.profile.timezone };
}) satisfies RouteLoader<unknown>;

export type KnowledgeItemProps = Awaited<ReturnType<typeof load>>;
