import { notFound, redirect } from "next/navigation";

import { getResult, markResultRead } from "@/application/schedules-service";

import { one, type RouteLoader } from "../../../route-contract";

/**
 * A scheduled result's stable link (notifications, Programados, Home). A run is a conversation
 * (ADR-041): its link opens that conversation's Live Canvas. Results from before that keep
 * rendering as they were stored.
 */
export const load = (async (auth, { params, search }) => {
  const result = await getResult(auth, params.id ?? "").catch(() => null);
  if (!result) notFound();
  if (result.conversationId) {
    if (!result.readAt) await markResultRead(auth, result.id).catch(() => undefined);
    // "Ver" from Home: the summary plays right away, as if "Escuchar el resumen" were tapped.
    redirect(`/chat/${result.conversationId}${one(search.listen) === "1" ? "?listen=1" : ""}`);
  }
  return {
    resultId: result.id,
    brief: result.brief,
    createdAt: result.createdAt,
    unread: result.readAt === null,
    title: result.title,
  };
}) satisfies RouteLoader<unknown>;

export type ResultProps = Awaited<ReturnType<typeof load>>;
