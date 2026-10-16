import "server-only";

import { serverEnv } from "@/config/server-env";
import { DEFAULT_VOICE, VOICE_KEYS, type VoiceKey } from "@/core/voice/catalog";

/**
 * Curated voice → ElevenLabs voice id, from server env only (ADR-030): 1 = ELISE, 2 = Martín,
 * 3 = Adriana. The legacy ELEVENLABS_VOICE_ID still gives ELISE her voice when _1 is unset.
 * These ids never reach the browser, the model, logs, tool outputs or the database.
 */
export function elevenVoices(): Record<string, string> {
  const env = serverEnv();
  const ids: Record<VoiceKey, string | undefined> = {
    elise: env.ELEVENLABS_VOICE_ID_1 ?? env.ELEVENLABS_VOICE_ID,
    martin: env.ELEVENLABS_VOICE_ID_2,
    adriana: env.ELEVENLABS_VOICE_ID_3,
  };
  return Object.fromEntries(
    Object.entries(ids).filter((e): e is [string, string] => Boolean(e[1])),
  );
}

/** ElevenLabs speaks when it is chosen, has a key and at least one voice. */
export function speaksElevenLabs(): boolean {
  const env = serverEnv();
  return (
    env.SPEECH_PROVIDER === "elevenlabs" &&
    Boolean(env.ELEVENLABS_API_KEY) &&
    Object.keys(elevenVoices()).length > 0
  );
}

/**
 * The voices a person may choose now, in catalog order. ELISE is always there (her OpenAI
 * stand-in speaks when ElevenLabs isn't set up); the others only with their voice configured.
 * Availability is configuration, not health: an ElevenLabs outage never removes a voice.
 */
export function availableVoiceKeys(): VoiceKey[] {
  const ids: Record<string, string> = speaksElevenLabs() ? elevenVoices() : {};
  return VOICE_KEYS.filter((k) => k === DEFAULT_VOICE || Boolean(ids[k]));
}
