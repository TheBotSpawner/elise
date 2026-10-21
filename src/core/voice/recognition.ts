/**
 * What the speech recognizer is told before it hears a turn (ADR-104): recognition hints only —
 * the language variant and a short list of names this user really uses — never instructions.
 * The provider takes a free-text prompt (OpenAI transcription: `prompt`, up to a few hundred
 * words; it costs nothing extra), and a bare ISO 639-1 `language` ("es"), never "es-AR".
 */

/** The prompt is cut here: long lists dilute the hint and slow nothing down but help nothing. */
export const RECOGNITION_CONTEXT_CHARS = 800;
/** Names of this user's own things (Spaces, accounts…) kept in the hint. */
export const RECOGNITION_TERMS = 30;

export interface RecognitionInput {
  locale: "es" | "en";
  /** The user's country (from their timezone), when known: "AR" → Rioplatense. */
  country: string | null;
  displayName: string | null;
  /** ELISE's own names (brands, sections), always first. */
  brandTerms: readonly string[];
  /** This user's names: subjects, clients, accounts — what they'll say and a model mishears. */
  userTerms: readonly string[];
}

export function recognitionContext(input: RecognitionInput): string {
  // A short sentence in the variant itself steers spelling and voseo better than a label.
  const variant =
    input.locale !== "es"
      ? ""
      : input.country === "AR"
        ? "Español rioplatense de Argentina, con voseo: ¿qué tenés hoy?, mostrame, revisame los mails, dale. "
        : "Español. ";
  const seen = new Set<string>();
  const terms = [...input.brandTerms, ...input.userTerms.slice(0, RECOGNITION_TERMS)]
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 2 && t.length <= 60)
    .filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  const speaker = input.displayName ? `Speaker: ${input.displayName}. ` : "";
  return `${variant}${speaker}Assistant: ELISE. Names: ${terms.join(", ")}.`.slice(
    0,
    RECOGNITION_CONTEXT_CHARS,
  );
}
