import { VOICES } from "./providers";

/**
 * Curated ELISE voices (ADR-030). A profile is what the user picks; it maps internally to a
 * provider and that provider's voice. Profiles carry no secrets and never expose a provider's
 * whole voice library. Later profiles may point at an ELISE-designed voice or a consented
 * professional clone without changing this shape.
 */

export type SpeechProviderId = "openai" | "elevenlabs";

export interface VoiceProfile {
  id: string;
  /** What the user sees ("ELISE"). */
  displayName: string;
  provider: SpeechProviderId;
  /** ElevenLabs: resolved from server configuration by profile id (env), never sent to clients. */
  providerVoice: string;
  /** Languages this voice was validated in. */
  languages: readonly ("es" | "en")[];
}

/** ElevenLabs profiles: their voice ids come from server env (ELEVENLABS_VOICE_ID[_ALT]). */
export const ELEVEN_PROFILES: readonly Omit<VoiceProfile, "providerVoice">[] = [
  { id: "elise", displayName: "ELISE", provider: "elevenlabs", languages: ["es", "en"] },
  {
    id: "elise-alt",
    displayName: "ELISE · alternativa",
    provider: "elevenlabs",
    languages: ["es", "en"],
  },
];

/** The current provider's voices stay available as profiles (fallback and A/B). */
export const OPENAI_PROFILES: readonly VoiceProfile[] = VOICES.map((v) => ({
  id: v,
  displayName: v[0]!.toUpperCase() + v.slice(1),
  provider: "openai" as const,
  providerVoice: v,
  languages: ["es", "en"] as const,
}));

/**
 * The profile actually used for a stored preference under the active provider: a voice from
 * the other provider (switched by flag) falls back to that provider's default, deterministically.
 */
export function resolveProfile(
  stored: string,
  provider: SpeechProviderId,
  elevenIds: readonly string[],
): string {
  if (provider === "elevenlabs")
    return elevenIds.includes(stored) ? stored : (elevenIds[0] ?? "elise");
  return (VOICES as readonly string[]).includes(stored) ? stored : VOICES[0];
}

/** A short, fixed, universal preview: never the user's own content. */
export const PREVIEW_TEXT = {
  es: "Hola, soy ELISE. Encontré tres opciones; la segunda parece la más conveniente. Te dejé el detalle en pantalla.",
  en: "Hi, I'm ELISE. I found three options; the second one looks like the best fit. I left the details on screen.",
} as const;
