/**
 * Representation analyzer (ADR-028): a cheap, deterministic look at evidence a tool already
 * retrieved, to say which representation it calls for — before the model writes prose. It
 * never extracts or invents values (the model does that, the planners validate it); it only
 * notices the SHAPE: several distinct dates are a schedule. (Comparable figures are already
 * routed to ui.visualize by the research instructions, ADR-027.) No model call, no I/O.
 */

export type RepresentationIntent = "temporal" | null;

const MONTHS =
  "ene(?:ro)?|feb(?:rero)?|mar(?:zo)?|abr(?:il)?|may(?:o)?|jun(?:io)?|jul(?:io)?|ago(?:sto)?|sep(?:t(?:iembre)?)?|set(?:iembre)?|oct(?:ubre)?|nov(?:iembre)?|dic(?:iembre)?|jan(?:uary)?|february|march|apr(?:il)?|june|july|aug(?:ust)?|september|october|november|dec(?:ember)?";

/** "25 de marzo", "22 y 23 de septiembre", "March 25", "25/03", "2026-03-25". */
const DATE_PATTERNS: RegExp[] = [
  /\b(20\d\d)-(\d\d)-(\d\d)\b/g,
  /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g,
  new RegExp(`\\b(\\d{1,2})(?:\\s*(?:y|al|-|–|a)\\s*\\d{1,2})?\\s+(?:de\\s+)?(${MONTHS})\\b`, "gi"),
  new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"),
];

/** How many distinct calendar dates a text mentions (month+day; years ignored). */
export function distinctDates(texts: readonly string[]): number {
  const seen = new Set<string>();
  for (const text of texts)
    for (const re of DATE_PATTERNS)
      for (const m of text.matchAll(re)) {
        const key = m[0].toLowerCase().replace(/\s+/g, " ");
        // "3/4" in "3/4 de los alumnos" is a fraction, not a date: require a plausible day/month.
        if (re === DATE_PATTERNS[1]) {
          const [d, mo] = [Number(m[1]), Number(m[2])];
          if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
        }
        seen.add(key);
      }
  return seen.size;
}

/**
 * The representation retrieved evidence calls for, if any. Three or more distinct dates are a
 * schedule worth a timeline or calendar; the caller turns this into a one-line instruction.
 */
export function representationHint(texts: readonly string[]): RepresentationIntent {
  return distinctDates(texts) >= 3 ? "temporal" : null;
}

/** The instruction a retrieval tool appends when its evidence is a schedule. */
export const TEMPORAL_HINT =
  "This evidence contains several dates (a schedule). In this same response call ui.timeline with each dated event (ISO date, title, kind, and its source: [n] for a Knowledge passage, the exact URL for a web page) so the schedule appears on screen, and keep your text to the key dates.";
