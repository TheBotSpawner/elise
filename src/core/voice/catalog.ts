import { VOICES, type VoiceName } from "./providers";

/**
 * ELISE's curated voices (ADR-030, amended 2026-10-16): the one catalog Settings, the chat's
 * voice tools, the turn context and speech synthesis read. A voice is a product identity with a
 * stable key; which provider speaks it, and with which provider voice, is resolved server-side
 * (infrastructure/ai/voices) and never leaves the server. No secrets or provider ids here.
 */
export const VOICE_KEYS = ["elise", "martin", "adriana"] as const;
export type VoiceKey = (typeof VOICE_KEYS)[number];

export const DEFAULT_VOICE: VoiceKey = "elise";

export interface EliseVoice {
  key: VoiceKey;
  name: string;
  gender: "female" | "male";
  /** Relative pitch among the catalog (higher number: higher voice); used by "más grave". */
  pitch: number;
  /** Compact, model-facing traits (the turn context and voice tools). */
  traits: readonly string[];
  /** Concise product description for Settings. */
  summary: { es: string; en: string };
  /** The OpenAI voice that stands in for this one when ElevenLabs can't speak (failover). */
  fallback: VoiceName;
}

/** In catalog order: the order Settings lists them and `voice.next` cycles through. */
export const VOICE_CATALOG: readonly EliseVoice[] = [
  {
    key: "elise",
    name: "ELISE",
    gender: "female",
    pitch: 3,
    traits: ["female", "young-adult", "latin-american", "subtle-rioplatense", "clear", "natural"],
    summary: {
      es: "Femenina · latina, rioplatense sutil · joven, clara y natural.",
      en: "Female · Latin American, subtly Rioplatense · young, clear and natural.",
    },
    fallback: "marin",
  },
  {
    key: "martin",
    name: "Martín",
    gender: "male",
    pitch: 1,
    traits: [
      "male",
      "adult",
      "argentine",
      "rioplatense",
      "warm",
      "calm",
      "confident",
      "medium-low",
    ],
    summary: {
      es: "Masculina · argentina · adulta, cálida, serena y segura.",
      en: "Male · Argentine · adult, warm, calm and confident.",
    },
    fallback: "cedar",
  },
  {
    key: "adriana",
    name: "Adriana",
    gender: "female",
    pitch: 2,
    traits: ["female", "adult", "argentine", "rioplatense", "warm", "composed", "slightly-low"],
    summary: {
      es: "Femenina · argentina · adulta, ligeramente grave, cálida y serena.",
      en: "Female · Argentine · adult, slightly low, warm and composed.",
    },
    fallback: "sage",
  },
];

export const isVoiceKey = (v: unknown): v is VoiceKey =>
  typeof v === "string" && (VOICE_KEYS as readonly string[]).includes(v);

export const voiceOf = (key: VoiceKey): EliseVoice => VOICE_CATALOG.find((v) => v.key === key)!;

/**
 * The voice actually used for a stored preference: kept while it's available; otherwise (none
 * stored, an old provider voice, or one whose voice isn't configured now) ELISE. Never rewrites
 * what's stored, so a voice that comes back resumes by itself.
 */
export function resolveVoice(stored: unknown, available: readonly VoiceKey[]): VoiceKey {
  return isVoiceKey(stored) && available.includes(stored) ? stored : DEFAULT_VOICE;
}

/** What a voice request may narrow by ("una voz masculina", "femenina, más grave"). */
export interface VoiceCriteria {
  gender?: "female" | "male";
  /** Lower than the current voice. */
  lower?: boolean;
}

/**
 * The next voice for "cambiá la voz" (deterministic): the following available voice in catalog
 * order, among those matching the criteria, never the current one. "Más grave" picks the closest
 * lower voice, or the lowest match when none is lower. Null: no other voice matches.
 */
export function nextVoice(
  current: VoiceKey,
  available: readonly VoiceKey[],
  criteria: VoiceCriteria = {},
): VoiceKey | null {
  const order = VOICE_CATALOG.filter(
    (v) =>
      available.includes(v.key) &&
      v.key !== current &&
      (!criteria.gender || v.gender === criteria.gender),
  );
  if (!order.length) return null;
  if (criteria.lower) {
    const pitch = voiceOf(current).pitch;
    const lower = order.filter((v) => v.pitch < pitch).sort((a, b) => b.pitch - a.pitch);
    return (lower[0] ?? [...order].sort((a, b) => a.pitch - b.pitch)[0]!).key;
  }
  const at = VOICE_KEYS.indexOf(current);
  return [...order].sort(
    (a, b) =>
      ((VOICE_KEYS.indexOf(a.key) - at + VOICE_KEYS.length) % VOICE_KEYS.length) -
      ((VOICE_KEYS.indexOf(b.key) - at + VOICE_KEYS.length) % VOICE_KEYS.length),
  )[0]!.key;
}

/** The OpenAI voice for a request's voice: a catalog key's stand-in, or an OpenAI name as is. */
export function openaiVoiceFor(voice: string): VoiceName {
  if ((VOICES as readonly string[]).includes(voice)) return voice as VoiceName;
  return isVoiceKey(voice) ? voiceOf(voice).fallback : VOICES[0];
}

/** A short, fixed preview line per voice (never the user's own content; few credits). */
export function previewText(key: VoiceKey, language: "es" | "en"): string {
  const name = voiceOf(key).name;
  if (key === DEFAULT_VOICE)
    return language === "es" ? "Hola. Esta es mi voz en ELISE." : "Hi. This is my voice in ELISE.";
  return language === "es"
    ? `Hola, soy ${name}. Esta es mi voz en ELISE.`
    : `Hi, I'm ${name}. This is my voice in ELISE.`;
}

/** Compact, safe metadata for the model (tools and turn context): never provider details. */
export const voiceForModel = (key: VoiceKey) => {
  const v = voiceOf(key);
  return { key: v.key, name: v.name, traits: v.traits };
};
