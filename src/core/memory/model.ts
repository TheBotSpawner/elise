import { AppError } from "../errors";

/**
 * Memory (ADR-068, ADR-107): stable facts about the person that make later answers better
 * without repeating them — preferences, routines, projects, usual names, decisions. Not Recall
 * (what was said), not Knowledge (their documents), not Methods (how to do a task), never
 * live data (a balance, an event) and never "every chat".
 *
 * Each fact says who it comes from (provenance), how sure ELISE is (certainty), which
 * interactions support it, and when it was last confirmed. A value only replaces another when
 * it comes from an equal or stronger source: an inference never overwrites what the person said.
 */
export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "project",
  "relationship",
  "routine",
  "goal",
  "constraint",
  "decision",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/**
 * - user_explicit: the person said it in a conversation.
 * - user_settings: the person wrote it in Settings › Memoria.
 * - tool_verified: read from their own data by a tool (never a guess).
 * - inferred: ELISE concluded it from what they said.
 * - unknown: kept from before provenance existed and not derivable honestly.
 */
export const PROVENANCES = [
  "user_explicit",
  "user_settings",
  "tool_verified",
  "inferred",
  "unknown",
] as const;
export type Provenance = (typeof PROVENANCES)[number];

export interface MemoryFact {
  id: string;
  /** Short stable key: "trabajo.horario", "formato.respuestas". */
  key: string;
  value: string;
  category: MemoryCategory;
  provenance: Provenance;
  /** 0–1. What the person said is 1; an inference says how sure it is. */
  certainty: number;
  status: "active" | "superseded";
  /** Interactions (conversation or voice session ids) that support it. */
  sources: string[];
  /** How many separate interactions confirmed it. */
  corroborations: number;
  observedAt: string;
  lastConfirmedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Learned in the background from conversations (not asked for in the moment). */
  learned: boolean;
}

/** Active facts a person can have; past it, ELISE learns nothing new until they review. */
export const MAX_ACTIVE_FACTS = 200;
const MAX_VALUE = 300;

/** What the person said, in a conversation or in Settings. */
export const isExplicit = (p: Provenance) => p === "user_explicit" || p === "user_settings";

/** Which source may replace which: equal or stronger only. */
const RANK: Record<Provenance, number> = {
  user_explicit: 3,
  user_settings: 3,
  tool_verified: 2,
  inferred: 1,
  unknown: 0,
};

/** Things that never belong in Memory: credentials, card numbers, keys. */
const SECRET =
  /(contraseñ|password|passcode|\bpin\b|cvv|api[\s_-]?key|token|secret|\b(?:\d[ -]?){13,19}\b|clave de acceso)/i;

/**
 * Memory is data, never instructions: a value that reads like an order to the model (from a
 * pasted email, a page, a crafted message) is refused, so it can't steer a later turn.
 */
export const INSTRUCTION_LIKE =
  /\b(ignor(a|á|e|ar|ad) (las |tus |todas las )?(instrucciones|reglas)|ignore (all |previous |the )?(instructions|rules)|system prompt|prompt del sistema|developer message|you must (always|never)|siempre deb[eé]s|ejecut[aá] (esta|la) herramienta|call the tool|jailbreak)\b/i;

export function memoryKey(raw: string): string {
  const key = raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  if (!key)
    throw new AppError("VALIDATION_ERROR", "A memory needs a short key", { recovery: "review" });
  return key;
}

export function cleanValue(raw: string): string {
  const value = raw.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE);
  if (!value)
    throw new AppError("VALIDATION_ERROR", "A memory needs a value", { recovery: "review" });
  if (SECRET.test(value))
    throw new AppError(
      "VALIDATION_ERROR",
      "Memory never keeps passwords, keys or card numbers. Don't save it; tell the user why.",
      { recovery: "review" },
    );
  if (INSTRUCTION_LIKE.test(value))
    throw new AppError(
      "VALIDATION_ERROR",
      "That reads like an instruction, not a fact about the user: Memory doesn't keep it.",
      { recovery: "review" },
    );
  return value;
}

export const sameValue = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export interface RememberInput {
  key: string;
  value: string;
  category?: MemoryCategory;
  provenance: Provenance;
  /** Defaults to 1 for what the person said, 0.6 for an inference. */
  certainty?: number;
  /** The interaction it came from (conversation or voice session); null in Settings. */
  source: string | null;
  /** Learned in the background. */
  learned?: boolean;
}

/** What remembering does to storage. Pure: the service writes it. */
export type MemoryChange =
  /** The same value again: confirmed (sources, corroborations, stronger provenance). */
  | { kind: "confirm"; fact: MemoryFact }
  /** A new value from an equal or stronger source: the old one becomes history. */
  | { kind: "replace"; fact: MemoryFact; replaced: MemoryFact }
  | { kind: "insert"; fact: MemoryFact }
  /** A weaker source contradicting what is known: nothing changes. */
  | { kind: "kept"; fact: MemoryFact };

/**
 * Adds, confirms or replaces the fact under one key, given its current active value. Same
 * input, same result (ids and time are given).
 */
export function remember(
  current: MemoryFact | null,
  input: RememberInput,
  now: string,
  newId: string,
): MemoryChange {
  const key = memoryKey(input.key);
  const value = cleanValue(input.value);
  const sources = input.source ? [input.source] : [];
  const certainty = clamp(input.certainty ?? (input.provenance === "inferred" ? 0.6 : 1));
  if (current && sameValue(current.value, value)) {
    const fresh = sources.filter((s) => !current.sources.includes(s));
    const stronger = RANK[input.provenance] > RANK[current.provenance];
    return {
      kind: "confirm",
      fact: {
        ...current,
        provenance: stronger ? input.provenance : current.provenance,
        certainty: Math.max(current.certainty, certainty),
        category: input.category ?? current.category,
        sources: [...current.sources, ...fresh],
        corroborations: current.corroborations + (fresh.length ? 1 : 0),
        lastConfirmedAt: now,
        updatedAt: now,
      },
    };
  }
  if (current && RANK[input.provenance] < RANK[current.provenance])
    return { kind: "kept", fact: current };
  const fact: MemoryFact = {
    id: newId,
    key,
    value,
    category: input.category ?? current?.category ?? "fact",
    provenance: input.provenance,
    certainty,
    status: "active",
    sources,
    corroborations: 1,
    observedAt: now,
    lastConfirmedAt: now,
    createdAt: now,
    updatedAt: now,
    learned: Boolean(input.learned),
  };
  return current
    ? { kind: "replace", fact, replaced: { ...current, status: "superseded", updatedAt: now } }
    : { kind: "insert", fact };
}

const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/** Edited by the person in Settings: it becomes what they wrote. */
export function editFact(fact: MemoryFact, value: string, now: string): MemoryFact {
  return {
    ...fact,
    value: cleanValue(value),
    provenance: "user_settings",
    certainty: 1,
    updatedAt: now,
    lastConfirmedAt: now,
  };
}

/**
 * A deleted interaction takes its evidence with it: its id leaves the fact, and an inference
 * left with no evidence is forgotten. What the person said stays until they remove it.
 */
export function prune(
  fact: MemoryFact,
  live: ReadonlySet<string>,
): { kind: "keep" } | { kind: "update"; sources: string[] } | { kind: "drop" } {
  const sources = fact.sources.filter((s) => live.has(s));
  if (sources.length === fact.sources.length) return { kind: "keep" };
  if (!isExplicit(fact.provenance) && fact.sources.length > 0 && sources.length === 0)
    return { kind: "drop" };
  return { kind: "update", sources };
}

export function activeFacts(facts: readonly MemoryFact[]): MemoryFact[] {
  return facts.filter((f) => f.status === "active").sort((a, b) => a.key.localeCompare(b.key));
}

// ── Context: only what helps this turn (ADR-107) ─────────────────────────────

/** What a prompt gets of a fact: the fact, where it comes from, how sure, and when. */
export type ContextFact = Pick<
  MemoryFact,
  "key" | "value" | "category" | "provenance" | "certainty" | "lastConfirmedAt"
>;

/** What a turn, a voice session or a brief gets of Memory: relevant facts and the profile. */
export interface MemoryContext {
  facts: ContextFact[];
  /** Profile lines, each backed by facts that are still active. */
  profile: string[];
}

export interface ContextLimits {
  all: number;
  relevant: number;
  core: number;
}

export const CONTEXT_LIMITS: ContextLimits = {
  /** With this many facts or fewer, all of them go (nothing to choose). */
  all: 8,
  /** Facts that share words with the message. */
  relevant: 12,
  /** Standing preferences and constraints the person stated (how to treat them), always. */
  core: 6,
};

const STOP = new Set(
  (
    "para como cuando este esta esto estos estas porque sobre tengo quiero puedo necesito " +
    "hacer donde desde hasta entre todo todos todas mucho poco algo nada cual cuales quien " +
    "that this with have from what when where which would could should about there their " +
    "your"
  ).split(" "),
);

/** Comparable word roots: accent-free, lowercase, first five letters ("reuniones" ~ "reunión"). */
export function stems(s: string): Set<string> {
  return new Set(
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .split(/[^a-z0-9ñ]+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
      .map((w) => w.slice(0, 5)),
  );
}

const toContext = ({
  key,
  value,
  category,
  provenance,
  certainty,
  lastConfirmedAt,
}: MemoryFact): ContextFact => ({ key, value, category, provenance, certainty, lastConfirmedAt });

/** A match this much weaker than the best one is noise, not relevance. */
const RELEVANCE_FLOOR = 0.5;

/**
 * The facts a turn uses — never a dump. With few facts, all of them; otherwise the ones that
 * share words with the message, plus their standing stated preferences and constraints.
 *
 * A shared word counts by how rare it is among the person's facts (a word in 50 facts says
 * little about which one is meant), and matches far weaker than the best are dropped. Ties go
 * to what the person said, then to the most recently confirmed. Deterministic.
 */
export function selectContextFacts(
  facts: readonly MemoryFact[],
  message = "",
  limits: ContextLimits = CONTEXT_LIMITS,
): ContextFact[] {
  const active = activeFacts(facts);
  if (active.length <= limits.all) return active.map(toContext);
  const asked = stems(message);
  const words = new Map(
    active.map((f) => [f.id, stems(`${f.key.replace(/[._]/g, " ")} ${f.value}`)]),
  );
  const df = new Map<string, number>();
  for (const ws of words.values()) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  const score = (f: MemoryFact) =>
    [...words.get(f.id)!].filter((w) => asked.has(w)).reduce((s, w) => s + 1 / df.get(w)!, 0);
  const byStrength = (a: MemoryFact, b: MemoryFact) =>
    RANK[b.provenance] - RANK[a.provenance] ||
    b.certainty - a.certainty ||
    b.lastConfirmedAt.localeCompare(a.lastConfirmedAt);
  const scored = active.map((f) => ({ f, score: score(f) })).filter((x) => x.score > 0);
  const best = Math.max(0, ...scored.map((x) => x.score));
  const relevant = scored
    .filter((x) => x.score >= best * RELEVANCE_FLOOR)
    .sort((a, b) => b.score - a.score || byStrength(a.f, b.f))
    .slice(0, limits.relevant)
    .map((x) => x.f);
  const chosen = new Set(relevant.map((f) => f.id));
  const core = active
    .filter(
      (f) =>
        !chosen.has(f.id) &&
        isExplicit(f.provenance) &&
        (f.category === "preference" || f.category === "constraint"),
    )
    .sort(byStrength)
    .slice(0, limits.core);
  return [...relevant, ...core].sort((a, b) => a.key.localeCompare(b.key)).map(toContext);
}

const SOURCE_LABEL: Record<Provenance, string> = {
  user_explicit: "the user said it",
  user_settings: "the user wrote it in Settings",
  tool_verified: "read from their own data",
  inferred: "your inference, not confirmed",
  unknown: "origin unknown",
};

/**
 * One line per fact for a prompt: who it comes from, how sure, when. An inference is marked
 * as a guess, so no model presents it as something the person told ELISE.
 */
export function memoryLines(facts: readonly ContextFact[]): string {
  return facts
    .map((f) => {
      const sure =
        f.provenance === "inferred" ? `, certainty ${Math.round(f.certainty * 100) / 100}` : "";
      return `- ${f.key}: ${f.value} (${SOURCE_LABEL[f.provenance]}${sure}; ${f.lastConfirmedAt.slice(0, 10)})`;
    })
    .join("\n");
}

// ── Profile: a short summary of the facts, each line citing them ─────────────

export interface ProfileLine {
  text: string;
  /** The active facts it summarizes (at least one). */
  facts: string[];
}

export const PROFILE_LIMITS = { lines: 12, chars: 220 } as const;

/**
 * A profile line survives only while every fact it cites is still active: its text may
 * mention any of them, so forgetting one removes the whole line (no regeneration needed).
 */
export function liveProfile(
  lines: readonly ProfileLine[],
  activeIds: ReadonlySet<string>,
): ProfileLine[] {
  return lines.filter((l) => l.facts.length > 0 && l.facts.every((id) => activeIds.has(id)));
}

export function profileLines(lines: readonly ProfileLine[]): string {
  return lines.map((l) => `- ${l.text}`).join("\n");
}
