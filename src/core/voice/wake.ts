/**
 * Wake phrase (ADR-017 §7-8): an allowlisted phrase that wakes a sleeping voice session.
 * Detection runs on the device (the browser's local speech recognition); this module only
 * decides, from a recognized text, whether it was the wake phrase — strictly — and what came
 * after it ("Elise, Morning Brief" → "Morning Brief").
 */

export const WAKE_PHRASES = ["elise", "hey_elise", "oye_elise", "liz"] as const;
export type WakePhrase = (typeof WAKE_PHRASES)[number];

/** How each phrase is said, plus the close spellings a recognizer produces for it. */
const FORMS: Record<WakePhrase, { lead: string[] | null; name: string[] }> = {
  elise: { lead: null, name: ["elise", "elis", "elisse", "eliss", "elize", "elice"] },
  hey_elise: { lead: ["hey", "ey", "hei"], name: ["elise", "elis", "elisse", "elize", "elice"] },
  oye_elise: { lead: ["oye"], name: ["elise", "elis", "elisse", "elize", "elice"] },
  liz: { lead: null, name: ["liz", "lis", "liss"] },
};

/** How the phrase reads in the UI and in the recognizer's biasing list. */
export const WAKE_LABELS: Record<WakePhrase, string> = {
  elise: "Elise",
  hey_elise: "Hey Elise",
  oye_elise: "Oye Elise",
  liz: "Liz",
};

/** Courtesy words allowed before a bare name ("ok Elise", "hola Elise"). */
const SOFT_LEAD = new Set(["ok", "okay", "hey", "ey", "oye", "hola", "che"]);

/** Recognizer confidence below this is ignored (when the recognizer reports one at all). */
export const WAKE_MIN_CONFIDENCE = 0.5;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export interface WakeMatch {
  matched: boolean;
  /** What the user said after the wake phrase, as recognized ("Morning Brief"). */
  remainder: string;
}

/**
 * The wake phrase must open the utterance (or be all of it): "Elise", "ok Elise, …",
 * "Hey Elise …". The name in the middle of a sentence ("le dije a Elise que…") never wakes.
 */
export function matchWake(
  text: string,
  phrase: WakePhrase,
  confidence: number | null = null,
): WakeMatch {
  const none = { matched: false, remainder: "" };
  if (confidence !== null && confidence > 0 && confidence < WAKE_MIN_CONFIDENCE) return none;
  const tokens = [...fold(text).matchAll(/[a-z0-9ñ]+/g)];
  if (!tokens.length) return none;
  const form = FORMS[phrase];
  let i = 0;
  if (form.lead) {
    if (!form.lead.includes(tokens[0]![0])) return none;
    i = 1;
  } else if (SOFT_LEAD.has(tokens[0]![0]) && tokens.length > 1) i = 1;
  const name = tokens[i];
  if (!name || !form.name.includes(name[0])) return none;
  // Folding changes lengths, so cut the original text after the same number of words.
  const words = [...text.normalize("NFC").matchAll(/[\p{L}\p{N}]+/gu)];
  const last = words[i];
  const rest = last
    ? text
        .normalize("NFC")
        .slice(last.index! + last[0].length)
        .replace(/^[\s,.:;!¡?¿-]+/, "")
        .trim()
    : "";
  return { matched: true, remainder: rest };
}
