import { AppError } from "../errors";

/**
 * Memory (ADR-068): a few stable facts about the person that make later answers better without
 * repeating them — preferences, routines, usual names, formats. Not Recall (what was said),
 * not Knowledge (their documents), not Methods (how to do a task), and never "every chat".
 *
 * Each fact keeps where it came from (the conversations that stated it), how sure ELISE is,
 * and when it was last confirmed. A contradiction only replaces a fact when the person said
 * it; an inference never overwrites what they said.
 */
export interface MemoryFact {
  id: string;
  /** Short stable key: "trabajo.horario", "formato.respuestas". */
  key: string;
  value: string;
  /** "stated": the person said it (or wrote it in Settings). "inferred": ELISE concluded it. */
  confidence: "stated" | "inferred";
  /** Conversations that support it. Empty for facts written in Settings. */
  sources: string[];
  status: "active" | "superseded";
  createdAt: string;
  updatedAt: string;
  lastConfirmedAt: string;
}

export const MAX_FACTS = 100;
const MAX_VALUE = 300;

/** Things that never belong in Memory: credentials, card numbers, keys. */
const SECRET =
  /(contraseñ|password|passcode|\bpin\b|cvv|api[\s_-]?key|token|secret|\b(?:\d[ -]?){13,19}\b|clave de acceso)/i;

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

function cleanValue(raw: string): string {
  const value = raw.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE);
  if (!value)
    throw new AppError("VALIDATION_ERROR", "A memory needs a value", { recovery: "review" });
  if (SECRET.test(value))
    throw new AppError(
      "VALIDATION_ERROR",
      "Memory never keeps passwords, keys or card numbers. Don't save it; tell the user why.",
      { recovery: "review" },
    );
  return value;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface RememberInput {
  key: string;
  value: string;
  confidence: MemoryFact["confidence"];
  /** The conversation it came from; null when written in Settings. */
  conversationId: string | null;
}

export interface RememberResult {
  facts: MemoryFact[];
  fact: MemoryFact;
  /** What it replaced, if the person changed a preference. */
  replaced: MemoryFact | null;
  /** An inference that contradicted what the person said: not saved. */
  kept: boolean;
}

/** Adds, confirms or updates one fact. Same input, same result (ids and time are given). */
export function remember(
  facts: readonly MemoryFact[],
  input: RememberInput,
  now: string,
  newId: string,
): RememberResult {
  const key = memoryKey(input.key);
  const value = cleanValue(input.value);
  const sources = input.conversationId ? [input.conversationId] : [];
  const current = facts.find((f) => f.key === key && f.status === "active");
  if (current && same(current.value, value)) {
    const fact: MemoryFact = {
      ...current,
      confidence: input.confidence === "stated" ? "stated" : current.confidence,
      sources: [...new Set([...current.sources, ...sources])],
      lastConfirmedAt: now,
      updatedAt: now,
    };
    return {
      facts: facts.map((f) => (f.id === current.id ? fact : f)),
      fact,
      replaced: null,
      kept: false,
    };
  }
  if (current && current.confidence === "stated" && input.confidence === "inferred")
    return { facts: [...facts], fact: current, replaced: null, kept: true };
  const fact: MemoryFact = {
    id: newId,
    key,
    value,
    confidence: input.confidence,
    sources,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: now,
  };
  const next = [
    ...facts.map((f) =>
      current && f.id === current.id ? { ...f, status: "superseded" as const, updatedAt: now } : f,
    ),
    fact,
  ];
  return { facts: cap(next), fact, replaced: current ?? null, kept: false };
}

/** Over the limit: superseded facts go first, then the least recently confirmed. */
function cap(facts: MemoryFact[]): MemoryFact[] {
  if (facts.length <= MAX_FACTS) return facts;
  const order = [...facts].sort(
    (a, b) =>
      Number(a.status === "active") - Number(b.status === "active") ||
      a.lastConfirmedAt.localeCompare(b.lastConfirmedAt),
  );
  const drop = new Set(order.slice(0, facts.length - MAX_FACTS).map((f) => f.id));
  return facts.filter((f) => !drop.has(f.id));
}

/** Edited by the person in Settings: it becomes what they said. */
export function editFact(
  facts: readonly MemoryFact[],
  id: string,
  value: string,
  now: string,
): MemoryFact[] {
  const clean = cleanValue(value);
  if (!facts.some((f) => f.id === id))
    throw new AppError("NOT_FOUND", "That memory no longer exists", { recovery: "review" });
  return facts.map((f) =>
    f.id === id
      ? { ...f, value: clean, confidence: "stated", updatedAt: now, lastConfirmedAt: now }
      : f,
  );
}

/** Forgets by id, or every fact under a key (and its history). */
export function forget(facts: readonly MemoryFact[], idOrKey: string): MemoryFact[] {
  const key = safeKey(idOrKey);
  return facts.filter((f) => f.id !== idOrKey && f.key !== key);
}

function safeKey(raw: string): string | null {
  try {
    return memoryKey(raw);
  } catch {
    return null;
  }
}

/**
 * A deleted conversation takes its evidence with it: its id leaves every fact, and an
 * inference left with no evidence is forgotten. What the person said stays until they remove it.
 */
export function prune(facts: readonly MemoryFact[], live: ReadonlySet<string>): MemoryFact[] {
  return facts.flatMap((f) => {
    const sources = f.sources.filter((s) => live.has(s));
    if (f.confidence === "inferred" && f.sources.length > 0 && sources.length === 0) return [];
    return [sources.length === f.sources.length ? f : { ...f, sources }];
  });
}

export function activeFacts(facts: readonly MemoryFact[]): MemoryFact[] {
  return facts.filter((f) => f.status === "active").sort((a, b) => a.key.localeCompare(b.key));
}
