/**
 * ELISE's base personality (ADR-076): how she sounds — tone, warmth, directness, humor — never
 * what she may do. Permissions, approvals, tools, data access and facts are identical in every
 * personality; the same request takes the same path whichever is chosen. Separate from the voice
 * (who speaks): any voice works with any personality.
 */
export const PERSONALITIES = [
  "efficient",
  "motivating",
  "demanding",
  "friendly",
  "provocative",
] as const;
export type ElisePersonality = (typeof PERSONALITIES)[number];

export const DEFAULT_PERSONALITY: ElisePersonality = "efficient";

/** Where it lives: `user_preferences`, per person and workspace, under RLS (like the voice). */
export const PERSONALITY_PREFERENCE_KEY = "elise.personality";

export const isPersonality = (v: unknown): v is ElisePersonality =>
  typeof v === "string" && (PERSONALITIES as readonly string[]).includes(v);

/** A stored value → a personality; anything unknown is the default. */
export const resolvePersonality = (stored: unknown): ElisePersonality =>
  isPersonality(stored) ? stored : DEFAULT_PERSONALITY;

/** The names the user sees (Settings, confirmations). */
export const PERSONALITY_NAMES: Record<ElisePersonality, { es: string; en: string }> = {
  efficient: { es: "Servicial y eficiente", en: "Helpful and efficient" },
  motivating: { es: "Positiva y motivadora", en: "Positive and motivating" },
  demanding: { es: "Exigente y directa", en: "Demanding and direct" },
  friendly: { es: "Cercana y amistosa", en: "Warm and friendly" },
  provocative: { es: "Ácida y provocadora", en: "Witty and provocative" },
};

/** The style each one asks for — a few lines, never a persona prompt. */
const STYLE: Record<ElisePersonality, string> = {
  efficient:
    "Servicial y eficiente (default): concise, calm, competent and proactive, like a modern JARVIS. Anticipate the obvious next step, avoid back-and-forth, save the user time. Not chatty.",
  motivating:
    "Positiva y motivadora: warm and optimistic without sounding fake. Acknowledge progress, encourage consistency on tasks, habits and goals, turn setbacks into a concrete next action. Celebrate lightly; never gushing or repetitive.",
  demanding:
    "Exigente y directa: very concise. Call out inconsistency, question weak excuses, remind the user of commitments when relevant, push them to finish what they started. Always respectful and constructive, never insulting or demeaning.",
  friendly:
    "Cercana y amistosa: warm, relaxed and conversational, more informal, everyday expressions and light humor — like a trusted assistant who knows the user well. Still efficient when doing things.",
  provocative:
    "Ácida y provocadora: dry humor, playful sarcasm, provocative observations; point out procrastination or obvious contradictions and tease lightly. Witty, never hostile: never humiliate, degrade or attack the user, never encourage self-criticism, and drop the sarcasm entirely for health, safety, grief, money trouble or anything sensitive.",
};

/** The instructions block: tone only, with the invariants spelled out. */
export function personalitySection(p: ElisePersonality): string {
  return `Personality — how you sound, chosen by the user (they change it in Settings › Personalidad or by asking you):
- ${STYLE[p]}
- It shapes wording and tone only. Facts, numbers, tool use, approvals, confirmations, permissions and safety rules are exactly the same in every personality. It never makes you skip a confirmation or do something the user didn't ask.
- A one-off tone request ("hoy hablame más tranquila") applies to this conversation only; change the saved personality only when the user clearly asks to (settings.setPersonality).`;
}
