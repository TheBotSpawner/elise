/**
 * History organized by Knowledge (ADR-020). A History thread (a conversation or a voice
 * session) can be linked to Spaces and Sections — structured references, never names, so a
 * rename shows everywhere. ELISE links conservatively from evidence; the user decides last.
 * Pure: no I/O here.
 */
import { nameKey } from "../contexts/model";
import type { ThreadRef } from "../interaction";

/** A Space (parentId null) or a Section (parentId = its Space). */
export interface KnowledgeNode {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  archived: boolean;
}

export type LinkSource = "automatic" | "manual";
export type LinkState = "linked" | "removed";

export interface ThreadLink {
  thread: ThreadRef;
  spaceId: string;
  source: LinkSource;
  state: LinkState;
  updatedAt: string;
}

export const threadKey = (t: ThreadRef) => `${t.kind}:${t.id}`;

export const HISTORY_LINKS = {
  /** ELISE adds at most this many links to one thread on its own. */
  maxAutomatic: 3,
  /** Below this, evidence is not enough to link. */
  threshold: 0.7,
  /** A name the user says must be at least this long to count as a mention ("UTN"). */
  minMentionChars: 3,
  /** Chips shown on a History row before "+N". */
  visibleChips: 2,
} as const;

/**
 * What a thread showed about a Space/Section. Deterministic, high-signal facts only: the user
 * activated it, the conversation started in it, its material was used, its name kept coming up.
 */
export interface ThreadEvidence {
  /** The active context during a turn was this Section (activation, study, work, meeting). */
  activated: Set<string>;
  /** The conversation was started from this Space/Section ("Ask ELISE" there). */
  scoped: Set<string>;
  /** Knowledge passages used, per turn: spaceId → number of distinct turns / passages. */
  knowledgeTurns: Map<string, number>;
  knowledgePassages: Map<string, number>;
  /** User turns that name the node exactly (word boundary, name or "Space › Section"). */
  mentionTurns: Map<string, number>;
}

export function emptyEvidence(): ThreadEvidence {
  return {
    activated: new Set(),
    scoped: new Set(),
    knowledgeTurns: new Map(),
    knowledgePassages: new Map(),
    mentionTurns: new Map(),
  };
}

export interface ScoredNode {
  spaceId: string;
  confidence: number;
  evidence: string[];
}

/** Confidence per node; only nodes at or above the threshold come back, best first. */
export function scoreEvidence(e: ThreadEvidence, nodes: KnowledgeNode[]): ScoredNode[] {
  const out: ScoredNode[] = [];
  for (const node of nodes) {
    if (node.archived) continue;
    const why: string[] = [];
    let c = 0;
    if (e.activated.has(node.id)) {
      c = Math.max(c, 0.95);
      why.push("active_context");
    }
    if (e.scoped.has(node.id)) {
      c = Math.max(c, 0.95);
      why.push("space_scope");
    }
    const kTurns = e.knowledgeTurns.get(node.id) ?? 0;
    const kPassages = e.knowledgePassages.get(node.id) ?? 0;
    // Material used in two turns, or substantially in one: the conversation is about it.
    if (kTurns >= 2 || kPassages >= 3) {
      c = Math.max(c, kTurns >= 2 ? 0.85 : 0.75);
      why.push("knowledge");
    }
    // The user naming a Space/Section exactly ("UTN", "Client A") says what the conversation is
    // about: once is enough. Generic names ("Personal", "Trabajo") need it said twice.
    const mentions = e.mentionTurns.get(node.id) ?? 0;
    if (mentions >= (isGenericName(node.name) ? 2 : 1)) {
      c = Math.max(c, 0.75);
      why.push("mentions");
    }
    if (c >= HISTORY_LINKS.threshold) out.push({ spaceId: node.id, confidence: c, evidence: why });
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, HISTORY_LINKS.maxAutomatic);
}

/**
 * Which automatic links to add. Never touches a link that exists (manual or automatic). A
 * link the user removed comes back only if they explicitly activate it after removing it
 * (`strongSince`: node → when that happened).
 */
export function linksToAdd(
  scored: ScoredNode[],
  existing: ThreadLink[],
  strongSince: Map<string, string> = new Map(),
): ScoredNode[] {
  const linked = existing.filter((l) => l.state === "linked");
  const room = Math.max(
    0,
    HISTORY_LINKS.maxAutomatic - linked.filter((l) => l.source === "automatic").length,
  );
  return scored
    .filter((s) => {
      const prior = existing.find((l) => l.spaceId === s.spaceId);
      if (!prior) return true;
      if (prior.state === "linked") return false;
      const at = strongSince.get(s.spaceId);
      return Boolean(at && at > prior.updatedAt);
    })
    .slice(0, room);
}

/** Space names that are everyday words: said once, they are not a topic. */
const GENERIC_NAMES = new Set(
  (
    "personal general varios otros otro misc trabajo work casa home hogar vida life notas notes " +
    "ideas proyectos projects clientes clients estudio study facultad university universidad " +
    "familia family salud health finanzas finance viajes travel"
  ).split(" "),
);

export function isGenericName(name: string): boolean {
  return GENERIC_NAMES.has(
    nameKey(name)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim(),
  );
}

/** Exact, word-bounded mentions of nodes in one user turn (accents and case ignored). */
export function mentionedNodes(text: string, nodes: KnowledgeNode[]): string[] {
  const hay = ` ${nameKey(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const hit = (name: string) => {
    const k = nameKey(name)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    return k.length >= HISTORY_LINKS.minMentionChars && hay.includes(` ${k} `);
  };
  return nodes
    .filter((n) => !n.archived)
    .filter((n) => hit(n.name) || (n.parentName ? hit(`${n.parentName} ${n.name}`) : false))
    .map((n) => n.id);
}

// ── Reading: chips, filters, groups ─────────────────────────────────────────

export interface Chip {
  id: string;
  label: string;
  archived: boolean;
}

/** A Section link reads as [Space] [Section]; duplicates collapse; Spaces first. */
export function chipsFor(spaceIds: string[], nodes: Map<string, KnowledgeNode>): Chip[] {
  const out: Chip[] = [];
  const add = (id: string) => {
    const n = nodes.get(id);
    if (!n || out.some((c) => c.id === id)) return;
    out.push({ id, label: n.name, archived: n.archived });
  };
  for (const id of spaceIds) {
    const n = nodes.get(id);
    if (!n) continue;
    if (n.parentId) add(n.parentId);
    add(id);
  }
  return out;
}

export type HistoryFilter =
  | { kind: "all" }
  | { kind: "untagged" }
  | { kind: "space"; spaceId: string; sectionId?: string | null };

/** Does a thread with these links pass the filter? A Space includes its Sections. */
export function matchesFilter(
  spaceIds: string[],
  filter: HistoryFilter,
  nodes: Map<string, KnowledgeNode>,
): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "untagged") return spaceIds.length === 0;
  if (filter.sectionId) return spaceIds.includes(filter.sectionId);
  return spaceIds.some((id) => id === filter.spaceId || nodes.get(id)?.parentId === filter.spaceId);
}

/** Nodes whose name (or "Space › Section" path) contains the query: search by tag. */
export function nodesMatching(query: string, nodes: KnowledgeNode[]): string[] {
  const q = nameKey(query).trim();
  if (q.length < 2) return [];
  return nodes
    .filter(
      (n) => nameKey(n.name).includes(q) || nameKey(`${n.parentName ?? ""} ${n.name}`).includes(q),
    )
    .flatMap((n) => [n.id, ...nodes.filter((c) => c.parentId === n.id).map((c) => c.id)]);
}

export interface Group<T> {
  key: string;
  label: string;
  /** For a Section group: its Space. */
  parentLabel: string | null;
  archived: boolean;
  items: T[];
}

/**
 * Groups by Space or by Section. A thread linked to several appears in each (it is about each);
 * untagged threads close the list. Group order follows the most recent thread in it.
 */
export function groupThreads<T extends { spaceIds: string[] }>(
  items: T[],
  by: "space" | "section",
  nodes: Map<string, KnowledgeNode>,
  untaggedLabel: string,
  generalLabel: (space: string) => string,
): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  const put = (key: string, make: () => Omit<Group<T>, "items">, item: T) => {
    const g = groups.get(key) ?? { ...make(), items: [] };
    if (!g.items.includes(item)) g.items.push(item);
    groups.set(key, g);
  };
  const untagged: T[] = [];
  for (const item of items) {
    const ids = item.spaceIds.filter((id) => nodes.has(id));
    if (!ids.length) {
      untagged.push(item);
      continue;
    }
    for (const id of ids) {
      const n = nodes.get(id)!;
      const space = n.parentId ? nodes.get(n.parentId) : n;
      if (by === "space" || !space) {
        const s = space ?? n;
        put(
          s.id,
          () => ({ key: s.id, label: s.name, parentLabel: null, archived: s.archived }),
          item,
        );
      } else if (n.parentId) {
        put(
          n.id,
          () => ({ key: n.id, label: n.name, parentLabel: space.name, archived: n.archived }),
          item,
        );
      } else {
        // Linked to the Space itself, not one of its Sections.
        put(
          `${n.id}:general`,
          () => ({
            key: `${n.id}:general`,
            label: generalLabel(n.name),
            parentLabel: n.name,
            archived: n.archived,
          }),
          item,
        );
      }
    }
  }
  const list = [...groups.values()];
  if (untagged.length)
    list.push({
      key: "untagged",
      label: untaggedLabel,
      parentLabel: null,
      archived: false,
      items: untagged,
    });
  return list;
}

// ── Titles ───────────────────────────────────────────────────────────────────

const OPENERS = [
  /^(hola|hey|buenas|buen d[ií]a|buenos d[ií]as|buenas tardes|buenas noches|hi|hello|good (morning|afternoon|evening))\b[\s,!.]*/i,
  /^(elise|eli)\b[\s,!.:]*/i,
  /^(me (podr[ií]as|pod[eé]s|ayud[aá]s a)|(podr[ií]as|pod[eé]s|quer[ií]a|quiero|necesito|necesitar[ií]a)( que)?( me)?|can you( please)?|could you( please)?|would you( please)?|please|por favor|i (want|wanted|need|would like) to( ask( you)?( about)?)?|quer[ií]a preguntarte( sobre)?|i wanted to ask( you)?( about)?)\b[\s,]*/i,
];

/**
 * A short, readable title from the first message until the summary provides a better one:
 * greetings, ELISE's name and politeness are dropped, and it is cut at a word boundary.
 * "Hola ELISE, ¿me podrías mostrar mi calendario de hoy?" → "Mostrar mi calendario de hoy".
 */
export function conciseTitle(firstMessage: string, max = 60): string {
  let t = firstMessage
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[¿¡]+/, "");
  for (let i = 0; i < 4; i++) {
    const before = t;
    for (const rx of OPENERS) t = t.replace(rx, "").replace(/^[¿¡,\s]+/, "");
    if (t === before) break;
  }
  t = t.replace(/[?!.¿¡]+$/g, "").trim();
  if (!t) t = firstMessage.trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    t = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 30)).trim()}…`;
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Resolves "Mathematics", "University › Mathematics" or an id among the nodes. */
export function resolveNode(
  ref: string,
  nodes: KnowledgeNode[],
): { node: KnowledgeNode } | { ambiguous: KnowledgeNode[] } | null {
  const live = nodes.filter((n) => !n.archived);
  const byId = nodes.find((n) => n.id === ref);
  if (byId) return { node: byId };
  const key = nameKey(ref.replace(/\s*[›>/]\s*/g, " "));
  const exact = live.filter(
    (n) =>
      nameKey(n.name) === key || (n.parentName && nameKey(`${n.parentName} ${n.name}`) === key),
  );
  const list = exact.length
    ? exact
    : live.filter((n) => key.length >= 3 && nameKey(n.name).includes(key));
  if (list.length === 1) return { node: list[0]! };
  if (list.length > 1) {
    // A Space and its same-named Section: prefer the Space.
    const spaces = list.filter((n) => !n.parentId);
    if (spaces.length === 1 && list.every((n) => !n.parentId || n.parentId === spaces[0]!.id))
      return { node: spaces[0]! };
    return { ambiguous: list };
  }
  return null;
}

/** Recall tiers for a node: itself → (for a Section) its Space and siblings → nothing. */
export function recallTiers(nodeId: string, nodes: KnowledgeNode[]): string[][] {
  const n = nodes.find((x) => x.id === nodeId);
  if (!n) return [];
  const children = (id: string) => nodes.filter((c) => c.parentId === id).map((c) => c.id);
  if (!n.parentId) return [[n.id, ...children(n.id)]];
  return [[n.id], [n.parentId, ...children(n.parentId).filter((id) => id !== n.id)]];
}

/** Storage of links (implemented over Supabase with the user's session: RLS applies). */
export interface HistoryLinksPort {
  /** The workspace's Spaces and Sections, archived included (old links keep their label). */
  nodes(): Promise<KnowledgeNode[]>;
  linksOf(threads: ThreadRef[]): Promise<ThreadLink[]>;
  set(
    thread: ThreadRef,
    spaceId: string,
    state: LinkState,
    source: LinkSource,
    extra?: { evidence?: string[]; confidence?: number },
  ): Promise<void>;
  /** Threads linked to any of these nodes, most recent first. */
  threadsFor(
    spaceIds: string[],
    limit: number,
  ): Promise<{ thread: ThreadRef; spaceId: string; title: string | null; at: string }[]>;
}
