import { z } from "zod";

import { notesOverview } from "@/application/native-service";

import { one, type RouteLoader } from "../../route-contract";

export const load = (async (auth, { search }) => {
  const query = one(search.q)?.slice(0, 200) ?? "";
  const note = one(search.note);
  const openId = note && z.uuid().safeParse(note).success ? note : null;
  // ADR-088: ?tags=<id>,<id> narrows to notes with every one of them.
  const tagIds = (one(search.tags)?.split(",") ?? [])
    .filter((id) => z.uuid().safeParse(id).success)
    .slice(0, 10);
  const { notes, spaces, tags } = await notesOverview(auth, query || null, tagIds);
  return { notes, spaces, tags, tagIds, query, openId, workspaceId: auth.workspaceId };
}) satisfies RouteLoader<unknown>;

export type NotesProps = Awaited<ReturnType<typeof load>>;
