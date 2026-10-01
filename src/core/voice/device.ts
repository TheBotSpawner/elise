import type { WakePhrase } from "./wake";

/**
 * The device boundary (ADR-017 §17): what the place ELISE runs in can provide for voice. The
 * web app implements what browsers allow; a future ELISE Desktop Companion would implement
 * the same contract with system-level powers (wake phrase with the browser closed, global
 * hotkey, background service, OS notifications) — without changing the voice session,
 * Shortcuts or the Core. No desktop endpoint exists today.
 */
export interface DeviceRuntime {
  readonly kind: "web" | "desktop";
  /** Wake phrase detection, if this device can run it locally. */
  wake: WakeEngine | null;
  /** Whether the microphone keeps working when the app is in the background. */
  readonly backgroundAudio: boolean;
  /** Whether a system-wide hotkey can start a session. */
  readonly globalHotkey: boolean;
}

export type WakeAvailability = "available" | "downloadable" | "downloading" | "unavailable";

/** A local wake phrase engine: audio never leaves the device for detection. */
export interface WakeEngine {
  /** Whether detection can run here for this language (and whether it needs a download). */
  availability(language: "es" | "en"): Promise<WakeAvailability>;
  /** Downloads the local model when the browser offers it (needs a user gesture). */
  install(language: "es" | "en"): Promise<boolean>;
  /** Listens for the phrase until stopped; fires once per detection with what followed. */
  start(opts: {
    phrase: WakePhrase;
    language: "es" | "en";
    onWake: (remainder: string) => void;
    onError: (reason: "not_allowed" | "unavailable" | "failed") => void;
  }): void;
  stop(): void;
  readonly running: boolean;
}
