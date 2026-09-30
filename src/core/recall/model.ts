import { keywordQuery } from "../knowledge/retrieval";

/**
 * Universal Recall (ADR-012): the user's past interactions with ELISE, retrievable without
 * remembering which conversation they happened in. Recall is evidence of what was said —
 * distinct from Knowledge (the user's documents) and Memory (learned preferences) — and never
 * an authorization: an old "always send emails automatically" changes no current policy.
 */

export type Modality = "text" | "voice" | "proactive" | "live";

/** One turn of an interaction: a chat message today, a voice utterance later. */
export interface RecallTurn {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface RecallSession {
  id: string;
  conversationId: string | null;
  modality: Modality;
  title: string | null;
  summary: string | null;
  topics: string[];
  startedAt: string;
  lastActivityAt: string;
}

export interface RecallHit {
  chunkId: string;
  sessionId: string;
  content: string;
  startedAt: string;
  endedAt: string;
  similarity: number | null;
  keywordMatched: boolean;
  score: number;
}

export interface RecallReader {
  search(q: {
    text: string;
    from?: Date | null;
    to?: Date | null;
    excludeConversationId?: string | null;
    /** A voice session in progress (it has no conversation). */
    excludeSessionId?: string | null;
    limit: number;
  }): Promise<{ hits: RecallHit[]; semantic: boolean }>;
  sessions(ids: string[]): Promise<RecallSession[]>;
  recent(q: {
    from?: Date | null;
    to?: Date | null;
    limit: number;
    excludeConversationId?: string | null;
    excludeSessionId?: string | null;
  }): Promise<RecallSession[]>;
  /** Turns of one session: around a moment, or the latest ones. */
  turns(sessionId: string, q: { around?: string | null; limit: number }): Promise<RecallTurn[]>;
}

/**
 * A recalled interaction as an application-level result — rendered today as a chat card,
 * later as a Live Workspace surface. Not coupled to any UI framework.
 */
export interface RecallResult {
  interactionId: string;
  title: string;
  date: string;
  lastActivity: string;
  summary: string | null;
  excerpts: { text: string; at: string }[];
  topics: string[];
  modality: Modality;
  /** Where the user can inspect it ("View interaction"); null for sessions without a thread. */
  url: string | null;
  relevance: { score: number; keyword: boolean; similarity: number | null };
}

export const RECALL = {
  candidates: 24,
  maxResults: 5,
  excerptsPerResult: 2,
  excerptChars: 420,
  /** Below this, a semantic-only match isn't evidence of a past discussion. */
  minSimilarity: 0.32,
  contextTurns: 12,
  turnChars: 900,
} as const;

export const isRecallEvidence = (h: RecallHit) =>
  h.keywordMatched || (h.similarity ?? 0) >= RECALL.minSimilarity;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Hits → one result per interaction (the best excerpts of each), strongest first. Weak
 * semantic-only matches are dropped, so "nothing found" stays honest.
 */
export function groupRecall(hits: RecallHit[], sessions: RecallSession[]): RecallResult[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const groups = new Map<string, RecallHit[]>();
  for (const h of hits.filter(isRecallEvidence)) {
    if (!byId.has(h.sessionId)) continue;
    groups.set(h.sessionId, [...(groups.get(h.sessionId) ?? []), h]);
  }
  return [...groups.entries()]
    .map(([id, list]) => {
      const s = byId.get(id)!;
      const best = [...list].sort((a, b) => b.score - a.score);
      return {
        interactionId: id,
        title: s.title || clip(best[0]!.content.replace(/^User: /, ""), 80),
        date: s.startedAt,
        lastActivity: s.lastActivityAt,
        summary: s.summary,
        excerpts: best
          .slice(0, RECALL.excerptsPerResult)
          .map((h) => ({ text: clip(h.content, RECALL.excerptChars), at: h.startedAt })),
        topics: s.topics,
        modality: s.modality,
        // A voice session has no History thread: it reopens on Home.
        url: s.conversationId
          ? `/chat/${s.conversationId}`
          : s.modality === "voice"
            ? `/?session=${s.id}`
            : null,
        relevance: {
          score: best[0]!.score + (list.length - 1) * 0.002,
          keyword: list.some((h) => h.keywordMatched),
          similarity: Math.max(...list.map((h) => h.similarity ?? 0)) || null,
        },
      };
    })
    .sort((a, b) => b.relevance.score - a.relevance.score)
    .slice(0, RECALL.maxResults);
}

// ── Chunking (deterministic, so re-indexing is idempotent) ──────────────────

export interface ChunkDraft {
  index: number;
  content: string;
  hash: string;
  sourceIds: string[];
  startedAt: string;
  endedAt: string;
}

const MAX_CHUNK = 1400;
const MAX_TURNS = 6;

/** FNV-1a over the text: identical excerpts are never re-embedded. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, "0")}${text.length.toString(16)}`;
}

/**
 * Consecutive turns → excerpts of up to ~1400 characters or 6 turns, starting at a user turn
 * where possible, so each excerpt reads as "what was asked / what ELISE answered".
 */
export function chunkTurns(turns: RecallTurn[]): ChunkDraft[] {
  const lines = turns
    .filter((t) => t.content.trim())
    .map((t) => ({
      ...t,
      text: `${t.role === "user" ? "User" : "ELISE"}: ${clip(t.content.trim().replace(/\s+\n/g, "\n"), t.role === "user" ? 1500 : 700)}`,
    }));
  const chunks: ChunkDraft[] = [];
  let current: typeof lines = [];
  const flush = () => {
    if (!current.length) return;
    const content = current.map((l) => l.text).join("\n");
    chunks.push({
      index: chunks.length,
      content,
      hash: contentHash(content),
      sourceIds: current.map((l) => l.id),
      startedAt: current[0]!.at,
      endedAt: current.at(-1)!.at,
    });
    current = [];
  };
  for (const line of lines) {
    const size = current.reduce((n, l) => n + l.text.length, 0);
    const full = size + line.text.length > MAX_CHUNK || current.length >= MAX_TURNS;
    if (current.length && (full || (line.role === "user" && size > MAX_CHUNK * 0.6))) flush();
    current.push(line);
  }
  flush();
  return chunks;
}

// ── When is recall relevant? ─────────────────────────────────────────────────

const RECALL_PATTERNS = [
  /\b(what|when) did (we|i|you)\b.*\b(discuss|decide|talk|say|agree|mention|plan)/i,
  /\b(last time|previous(ly)?|earlier|before) (we|i|you)\b/i,
  /\b(do you )?remember\b/i,
  /\b(the )?conversation (where|about|when)\b/i,
  /\bwhat (have|did) we (discussed|talked|decided)\b/i,
  /\bwe (discussed|talked about|decided|agreed)\b/i,
  /\bi (told|said to) you\b/i,
  /\bqu[eé] (hablamos|decidimos|dijimos|charlamos|conversamos|acordamos|te dije)\b/i,
  /\b(la|aquella) (vez|conversaci[oó]n) (que|donde|en que)\b/i,
  /\bla [uú]ltima vez\b/i,
  /\bte (dije|coment[eé]|cont[eé])\b/i,
  /\b(hablamos|conversamos|charlamos|decidimos|acordamos) (de|sobre|que)\b/i,
  /\b(te acord[aá]s|record[aá]s)\b/i,
];

/** Deterministic trigger: the request refers to earlier interactions. */
export function recallIntent(message: string): boolean {
  return RECALL_PATTERNS.some((re) => re.test(message));
}

export { keywordQuery };
