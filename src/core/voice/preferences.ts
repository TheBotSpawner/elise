import type { VoiceChoice } from "./providers";
import type { WakePhrase } from "./wake";

/**
 * Voice preferences (ADR-068). The person chooses three things: continuous conversation, the
 * voice language and the voice. Everything else is a good default, not a setting:
 * - the microphone is always offered, replies to voice are spoken, speaking over ELISE
 *   interrupts her (barge-in) and quiet speech is matched (adaptive delivery, per device);
 * - the wake phrase is always "Elise". On the web it only wakes a voice session that is
 *   resting in a visible tab, and only while continuous conversation is on.
 * Older rows (custom phrase, toggles turned off) read safely into this model, with no migration.
 */
export const WAKE_PHRASE: WakePhrase = "elise";

export const VOICE_LANGUAGES = ["auto", "es", "en"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

/** The stored columns this reads (user_profiles). */
export interface VoiceRow {
  voice_language: VoiceLanguage;
  voice_name: VoiceChoice;
  voice_continuous: boolean | null;
}

export function voicePreferences(row: VoiceRow) {
  const continuous = row.voice_continuous ?? false;
  return {
    enabled: true,
    speak: true,
    language: row.voice_language,
    voice: row.voice_name,
    continuous,
    bargeIn: true,
    wakeEnabled: continuous,
    wakePhrase: WAKE_PHRASE,
  };
}

/**
 * Product preference, OS permission and device capability are three different things
 * (ADR-068 §native): "continuous conversation on" never means the microphone is allowed, nor
 * that this device can listen for "Elise" in the background.
 */
export type BackgroundWake = "unsupported" | "available" | "enabled";

export interface VoiceDeviceCapabilities {
  platform: "web" | "ios" | "android";
  microphone: "granted" | "denied" | "prompt" | "unknown";
  /** A browser never listens with the app in the background or the screen locked. */
  backgroundWake: BackgroundWake;
}

/** What a web page can honestly claim. A native app reports its own capabilities. */
export function webVoiceCapabilities(
  microphone: VoiceDeviceCapabilities["microphone"],
): VoiceDeviceCapabilities {
  return { platform: "web", microphone, backgroundWake: "unsupported" };
}
