import "server-only";

import type { EvidenceFact, MemoryEvidence } from "@/core/capabilities/settings";
import { REPHRASE_OVERLAP } from "@/core/memory/extraction";
import { selectContextFacts, stems, type MemoryFact } from "@/core/memory/model";

import type { AuthContext } from "./auth-context";
import { getMemory, memoryRepo, printHasher } from "./memory-service";
import { searchRecall } from "./recall-service";

/**
 * Evidence about the person for a question (ADR-107, memory.reflect): what they said, what
 * was inferred, how it changed, the profile, and the past conversations that bear on it —
 * kept apart so the answer never passes an inference off as their words. No extra model
 * call: the turn's own model reasons over this, so it costs no more than a Recall search.
 * Only this person's memory and interactions are read (RLS).
 */
const LIMITS = { all: 10, relevant: 15, core: 4 } as const;
const EPISODES = 5;

const evidence = (f: MemoryFact): EvidenceFact => ({
  key: f.key,
  value: f.value,
  provenance: f.provenance,
  certainty: f.certainty,
  since: f.observedAt.slice(0, 10),
  lastConfirmed: f.lastConfirmedAt.slice(0, 10),
  times: f.corroborations,
});

export async function reflectOnMemory(
  auth: AuthContext,
  question: string,
  range: { from?: string; to?: string },
): Promise<MemoryEvidence> {
  const m = await getMemory(auth);
  const empty: MemoryEvidence = {
    said: [],
    inferred: [],
    changes: [],
    profile: [],
    episodes: [],
    omitted: 0,
  };
  if (!m.enabled) return empty;
  const repo = memoryRepo(auth.db, auth.workspaceId, auth.userId);
  const keys = new Set(selectContextFacts(m.facts, question, LIMITS).map((f) => f.key));
  const chosen = m.facts.filter((f) => keys.has(f.key));
  const [all, prints, hits] = await Promise.all([
    repo.all().catch(() => []),
    repo.prints().catch(() => []),
    searchRecall(auth, question, null, EPISODES).catch(() => []),
  ]);
  // Past conversations that mention something forgotten are left out (and counted).
  const hash = printHasher(auth.userId);
  const forgottenWords = prints.map((p) => new Set(p.wordHashes));
  const mentionsForgotten = (text: string) => {
    if (!forgottenWords.length) return false;
    const mine = new Set([...stems(text)].map((w) => hash(`w:${w}`)));
    return forgottenWords.some((words) => {
      if (words.size < 2) return false;
      const same = [...words].filter((w) => mine.has(w)).length;
      return same / words.size >= REPHRASE_OVERLAP;
    });
  };
  let omitted = 0;
  const episodes: MemoryEvidence["episodes"] = [];
  for (const h of hits) {
    if (range.from && h.lastActivity.slice(0, 10) < range.from) continue;
    if (range.to && h.date.slice(0, 10) >= range.to) continue;
    const excerpt = h.excerpts.map((x) => x.text).join(" … ");
    if (mentionsForgotten(`${h.summary ?? ""} ${excerpt}`)) {
      omitted++;
      continue;
    }
    episodes.push({
      at: h.date,
      title: h.title,
      excerpt: excerpt.slice(0, 600),
      interactionId: h.interactionId,
    });
  }
  return {
    said: chosen.filter((f) => f.provenance !== "inferred").map(evidence),
    inferred: chosen.filter((f) => f.provenance === "inferred").map(evidence),
    changes: all
      .filter((f) => f.status === "superseded" && keys.has(f.key))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((f) => ({ key: f.key, value: f.value, until: f.updatedAt.slice(0, 10) })),
    profile: m.profile.map((l) => l.text),
    episodes,
    omitted,
  };
}
