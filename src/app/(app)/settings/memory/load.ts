import { getMemory } from "@/application/memory-service";

import type { RouteLoader } from "../../route-contract";

export const load = (async (auth) => {
  const state = await getMemory(auth);
  // Which sources can be opened ("Ver conversación"): conversations, not voice sessions.
  const ids = [...new Set(state.facts.flatMap((f) => f.sources))];
  const { data } = ids.length
    ? await auth.db.from("conversations").select("id").in("id", ids).is("archived_at", null)
    : { data: [] };
  // Learned in the last two weeks: shown on their own, newest first.
  const since = Date.now() - 14 * 86_400_000;
  const recent = state.facts
    .filter((f) => f.learned && Date.parse(f.createdAt) >= since)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5)
    .map((f) => f.id);
  return { state, conversations: (data ?? []).map((r) => r.id), recent };
}) satisfies RouteLoader<unknown>;

export type MemoryProps = Awaited<ReturnType<typeof load>>;
