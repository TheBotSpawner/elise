import type { CanonicalMatch } from "../lexicon";
import type { ToolCallOutcome } from "./executor";

/**
 * Conversational repair (ADR-065): when the user corrects something ELISE just did ("no, era Mi
 * ELISE", "mejor 15", "you spelled that wrong"), the correction is the go-ahead — ELISE fixes
 * the same object instead of asking or creating a second one.
 *
 * The model reads the correction; the code decides what can be corrected: every write leaves an
 * EntityReference in the turn's notes, and the target of a repair is resolved from those — never
 * from an id the model made up.
 */

/** Something a write created or changed, as later turns can point at it. */
export interface EntityReference {
  type: string;
  id: string;
  /** Its name or title after the write, as the user sees it. */
  displayName?: string;
  /** Where it lives, when the id is the container's (a list item lives in its list). */
  parent?: string;
  sourceAction: string;
}

/** The tool that corrects each kind of object, and how it names that object. */
const REPAIR: Record<string, { tool: string; ref: (r: EntityReference) => string; undo: string }> =
  {
    task: { tool: "tasks.update", ref: (r) => `taskId "${r.id}"`, undo: "tasks.delete" },
    list_item: {
      tool: "lists.updateItem",
      ref: (r) => `list "${r.parent ?? r.id}", item "${r.displayName ?? ""}"`,
      undo: "lists.removeItem",
    },
    habit: { tool: "habits.update", ref: (r) => `habit "${r.id}"`, undo: "habits.delete" },
    goal: { tool: "goals.update", ref: (r) => `goal "${r.id}"`, undo: "goals.delete" },
    note: { tool: "notes.update", ref: (r) => `note "${r.id}"`, undo: "notes.archive" },
    finance_transaction: {
      tool: "finance.updateTransaction",
      ref: (r) => `transaction "${r.id}"`,
      undo: "finance.archiveTransaction",
    },
  };

const NOUNS: Record<string, { es: string; en: string; words: RegExp }> = {
  task: { es: "la tarea", en: "the task", words: /\b(tarea|task|pendiente)\b/i },
  list_item: { es: "el ítem", en: "the item", words: /\b([ií]tem|item|lista|list)\b/i },
  habit: { es: "el hábito", en: "the habit", words: /\b(h[aá]bito|habit)\b/i },
  goal: { es: "el objetivo", en: "the goal", words: /\b(objetivo|meta|goal)\b/i },
  note: { es: "la nota", en: "the note", words: /\b(nota|note)\b/i },
  finance_transaction: {
    es: "el movimiento",
    en: "the transaction",
    words: /\b(movimiento|gasto|ingreso|transaction|expense)\b/i,
  },
};

const clean = (s: string) => s.replace(/["()\n]/g, "'").slice(0, 120);

/** What a successful write left behind that the user may correct next. */
export function entityRefs(name: string, outcome: ToolCallOutcome): EntityReference[] {
  if (outcome.status !== "succeeded" || !outcome.target) return [];
  const { target, display, output } = outcome;
  const base = { type: target.type, id: target.id, sourceAction: name };
  const out = (output ?? {}) as { added?: unknown; updated?: unknown };
  switch (display?.kind) {
    case "task":
      return [{ ...base, type: "task", id: display.task.id, displayName: display.task.title }];
    case "native_list": {
      const items = Array.isArray(out.added)
        ? out.added
        : typeof out.updated === "string"
          ? [out.updated]
          : [];
      return items
        .filter((i): i is string => typeof i === "string")
        .map((item) => ({
          ...base,
          type: "list_item",
          parent: display.list.name,
          displayName: item,
        }));
    }
    case "habits":
      return [
        {
          ...base,
          displayName: display.progress.find((p) => p.habitId === target.id)?.name,
        },
      ];
    case "goal":
      return [{ ...base, displayName: display.detail.snapshot.goal.title }];
    case "note":
      return [{ ...base, displayName: display.note.title }];
    case "finance_transaction": {
      const t = display.transaction;
      const label = [t.description ?? t.counterparty, `${t.amount} ${t.currency}`]
        .filter(Boolean)
        .join(" · ");
      return [{ ...base, displayName: label }];
    }
    default:
      return REPAIR[target.type] ? [base] : [];
  }
}

/** `(ref task:<id> "Comprar huevos")`, parsed back by refsInNotes. */
export function refNote(r: EntityReference): string {
  return `(ref ${r.type}:${r.id}${r.parent ? ` in "${clean(r.parent)}"` : ""}${r.displayName ? ` "${clean(r.displayName)}"` : ""} by ${r.sourceAction})`;
}

const REF = /\(ref ([a-z_]+):([^\s)]+)(?: in "([^"]*)")?(?: "([^"]*)")? by ([\w.]+)\)/g;

export function refsInNotes(notes: readonly string[]): EntityReference[] {
  return notes.flatMap((note) =>
    [...note.matchAll(REF)].map((m) => ({
      type: m[1]!,
      id: m[2]!,
      ...(m[3] ? { parent: m[3] } : {}),
      ...(m[4] ? { displayName: m[4] } : {}),
      sourceAction: m[5]!,
    })),
  );
}

// ── Is the user correcting what ELISE just did? ─────────────────────────────

const CORRECT = new RegExp(
  [
    // Spanish
    String.raw`\b(te |lo |la |me )?(lo |la )?(escribiste|pusiste|anotaste|entendiste|agregaste|cargaste) mal\b`,
    String.raw`\b(qued[oó]|est[aá]) mal\b`,
    String.raw`\bte equivocaste\b`,
    String.raw`\bcorreg[ií]\w*|\bcorrig\w*`,
    String.raw`\bquise decir\b`,
    String.raw`\bme refer[ií]a\b`,
    String.raw`^\s*en realidad\b`,
    String.raw`^\s*no[\s,.!]+(no[\s,.!]+)?(era|eran|es|son|fue|fueron|dec[ií]a|dije|ah[ií]|eso|mejor)\b`,
    String.raw`^\s*(era|eran)\b`,
    String.raw`\bcambi[aá](lo|la|le)? (por|a)\b`,
    String.raw`\bpon[eé](lo|la|le) como\b`,
    String.raw`^\s*mejor (\d|ponele|ponelo|que diga)`,
    String.raw`\beso [uú]ltimo (era|es)\b`,
    String.raw`\b(el|ese) (nombre|t[ií]tulo|monto) (est[aá]|qued[oó]) mal\b`,
    // Spelling it out: "Marcos con s", "con T al final".
    String.raw`\bcon (una |la )?\p{L}( al final)?\s*[.!]?$`,
    // English
    String.raw`\bi meant\b`,
    String.raw`\byou (spelled|wrote|got|put) (that|it) wrong\b`,
    String.raw`\bspelled (that|it) wrong\b`,
    String.raw`^\s*actually,? (it'?s|it was|make|i)\b`,
    String.raw`\bmake (that|it) \S`,
    String.raw`\bchange (it|that|the last \w+) to\b`,
    String.raw`^\s*no,? (it was|it's|it should be|i said)\b`,
    String.raw`\bthat'?s (wrong|not right)\b`,
  ].join("|"),
  "iu",
);

const REVERT =
  /\b(deshac[eé](lo|la)?|dej[aá](lo|la) como estaba|como estaba antes|volv[eé](lo|la)? (atr[aá]s|a como estaba)|undo (that|it|the last)|put it back|revert (it|that))\b/i;

/** "capaz", "maybe": the user is thinking aloud — not a correction to act on. */
const TENTATIVE = /\b(capaz|quiz[aá]s?|tal vez|no s[eé] si|maybe|perhaps|i wonder|might be)\b/i;

/** "además agregá…", "also add": something new, not a correction. */
const ADDITION = /\b(adem[aá]s|tambi[eé]n agreg|agreg[aá] tambi[eé]n|also add|and also|as well)\b/i;

export type RepairIntent = { kind: "correct" | "revert" };

/** "No, leche." right after a write: a short "no" with a replacement. */
const SHORT_NO =
  /^\s*no[\s,.!]+(?!gracias|est[aá] bien|nada|dale|todav[ií]a|perfecto|ok|thanks|that'?s (fine|ok)|nothing|never ?mind)\p{L}/iu;

export function detectRepair(message: string): RepairIntent | null {
  if (ADDITION.test(message) || TENTATIVE.test(message)) return null;
  if (REVERT.test(message)) return { kind: "revert" };
  if (CORRECT.test(message)) return { kind: "correct" };
  if (SHORT_NO.test(message) && message.trim().split(/\s+/).length <= 6) return { kind: "correct" };
  return null;
}

// ── Which object? ────────────────────────────────────────────────────────────

export type RepairTarget =
  | { kind: "one"; ref: EntityReference; previous: string | null }
  | { kind: "ambiguous"; refs: EntityReference[] }
  | { kind: "none" };

const key = (r: EntityReference) =>
  `${r.type}:${r.id}:${r.type === "list_item" ? r.displayName : ""}`;

/**
 * The object a correction is about: what the previous turn wrote (narrowed by the noun the user
 * used — "la tarea", "el gasto"); several left → ask; nothing correctable → no repair.
 */
export function resolveRepairTarget(
  history: readonly { role: string; toolNotes?: string[] }[],
  message: string,
): RepairTarget {
  const turns = history.filter((m) => m.role === "assistant");
  const last = turns.at(-1);
  const refs = [
    ...new Map(
      refsInNotes(last?.toolNotes ?? [])
        .filter((r) => REPAIR[r.type])
        .map((r) => [key(r), r]),
    ).values(),
  ];
  if (!refs.length) return { kind: "none" };
  const named = refs.filter((r) => NOUNS[r.type]?.words.test(message));
  const pool = named.length ? named : refs;
  if (pool.length > 1) return { kind: "ambiguous", refs: pool };
  const ref = pool[0]!;
  // What it was before this turn's change, for "dejalo como estaba".
  const earlier = turns
    .slice(0, -1)
    .flatMap((t) => refsInNotes(t.toolNotes ?? []))
    .filter((r) => r.type === ref.type && r.id === ref.id && r.displayName !== ref.displayName);
  return { kind: "one", ref, previous: earlier.at(-1)?.displayName ?? null };
}

/** The repair tool for a target (logging and tests). */
export const repairTool = (type: string) => REPAIR[type]?.tool ?? null;

/** Turn guidance for a repair: what to fix and with which tool — the ids come from here. */
export function repairHint(
  intent: RepairIntent,
  target: RepairTarget,
  locale: "es" | "en",
): string | null {
  if (target.kind === "none") return null;
  if (target.kind === "ambiguous") {
    const options = target.refs
      .map((r) => `${NOUNS[r.type]?.[locale] ?? r.type} "${r.displayName ?? r.id}"`)
      .join(locale === "es" ? " o " : " or ");
    return `The user is correcting something you just did, but several things were just written (${options}). Ask one short question naming them ("¿${options}?"), then fix only that one with its update tool. Never guess.`;
  }
  const { ref, previous } = target;
  const r = REPAIR[ref.type]!;
  const what = `${NOUNS[ref.type]?.en ?? ref.type} "${ref.displayName ?? ref.id}" (${r.ref(ref)})`;
  if (intent.kind === "revert")
    return previous
      ? `The user wants to undo your last change to ${what}. Restore its previous value "${previous}" with ${r.tool} now — same object, no question — then say it's back as it was.`
      : `The user wants to undo creating ${what}. Undoing a creation removes it: use ${r.undo} on that same object (its approval rules apply as usual), then say so briefly.`;
  return `The user is correcting what you just did to ${what}. Their correction is the go-ahead: fix it now with ${r.tool} on that same object, changing only what they corrected and keeping everything else. Don't ask whether to fix it, never create a new one, and don't apply or update a Method for this. Reply in one short line with the final value ("Corregido: ahora dice …"); by voice just "Listo, corregido." If the tool fails, say you understood the correction but couldn't update it.`;
}

/** Turn guidance for names heard one way and meaning a known one (product names, Spaces…). */
export function canonicalHint(matches: readonly CanonicalMatch[]): string | null {
  const lines = matches.map((m) =>
    m.kind === "resolved"
      ? `"${m.ref.raw}" in the user's words is "${m.ref.resolved}" (a known name; speech recognition misheard it). Write "${m.ref.resolved}", never "${m.ref.raw}".`
      : m.kind === "suggested"
        ? `"${m.ref.raw}" is probably "${m.ref.resolved}" misheard (a known name). Write "${m.ref.resolved}" unless the user says it's a different name.`
        : `"${m.raw}" could be ${m.candidates.map((c) => `"${c}"`).join(" or ")}: if the conversation doesn't make it clear, ask which.`,
  );
  return lines.length ? lines.join("\n") : null;
}
