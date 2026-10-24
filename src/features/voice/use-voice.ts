"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { VoicePreferences } from "@/application/auth-context";
import type { VoiceLanguage } from "@/core/voice/providers";
import { initialVoice, type VoiceState } from "@/core/voice/session";
import type { SendOptions, StreamListener } from "@/features/chat/use-elise-chat";
import { latestDailySummaryAction } from "@/features/schedules/actions";
import { useI18n } from "@/lib/i18n/client";

import {
  onDeviceWake,
  pageHasWake,
  onVoiceControl,
  onVoiceEnd,
  publishVoicePhase,
  useDeviceWake,
} from "./device-wake";
import { Microphone, MicError } from "./microphone";
import { SpeechPlayer } from "./speech-player";
import {
  VOICE_PREFS_EVENT,
  VoiceController,
  type VoiceMarks,
  type VoicePrefs,
} from "./voice-controller";
import { WebSpeechWakeEngine } from "./wake-engine";

/** React binding of the voice session: browser audio in, the chat stream out. */
export function useVoice({
  prefs,
  send,
  stop,
  subscribe,
  level,
  deviceWakeFallback = false,
}: {
  prefs: VoicePreferences;
  send: (text: string, options?: SendOptions) => Promise<void>;
  /** Cancels the chat request in flight. */
  stop?: () => void;
  subscribe: (fn: StreamListener) => () => void;
  /** Shared with the Orb: the live input or output amplitude. */
  level: { current: number };
  /** The corner Orb's session: device wakes reach it only when no page has a conversation. */
  deviceWakeFallback?: boolean;
}) {
  const { locale } = useI18n();
  const language: "es" | "en" = prefs.language === "auto" ? locale : prefs.language;
  const toPrefs = (p: VoicePreferences): VoicePrefs => ({
    speak: p.speak,
    bargeIn: p.bargeIn,
    continuous: p.continuous,
    wakeEnabled: p.wakeEnabled,
    wakePhrase: p.wakePhrase,
    language,
    adaptiveDelivery: adaptiveDeliveryEnabled(),
    instantAck: true,
  });
  // ELISE Desktop listens for "ELISE" itself, in the background (ADR-095): the browser's
  // wake phrase engine isn't used there, and the session keeps going with the window hidden.
  const deviceWake = useDeviceWake();
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const [wake] = useState(() =>
    typeof window !== "undefined" && !deviceWake && WebSpeechWakeEngine.supported()
      ? new WebSpeechWakeEngine()
      : null,
  );
  const [state, setState] = useState<VoiceState>(() => ({
    ...initialVoice,
    speak: prefs.speak,
    bargeIn: prefs.bargeIn,
    continuous: prefs.continuous,
    wake: prefs.wakeEnabled ? "ready" : "off",
  }));
  const [controller] = useState(
    () =>
      new VoiceController(
        {
          createMic: () => new Microphone(),
          createPlayer: () => new SpeechPlayer(),
          transcribe,
          send: () => {},
          onState: setState,
          onTimings: reportTimings,
          micProblem: (e) => (e instanceof MicError ? e.problem : "not_supported"),
          wake,
          online: () => navigator.onLine,
          trace: voiceTrace(),
          // ADR-102: on ELISE Desktop the wake word is its own persisted setting (re-enabled
          // from Settings or the tray). The controller turns a browser's wake phrase off itself.
          disableWake: () => {
            const desktop = (
              window as {
                eliseDesktop?: { setPreferences?: (p: { wakeWord: boolean }) => Promise<unknown> };
              }
            ).eliseDesktop;
            void desktop?.setPreferences?.({ wakeWord: false });
          },
          enableWake: () => {
            const desktop = (
              window as {
                eliseDesktop?: { setPreferences?: (p: { wakeWord: boolean }) => Promise<unknown> };
              }
            ).eliseDesktop;
            void desktop?.setPreferences?.({ wakeWord: true });
          },
          // "Decime mi resumen del día": the latest one opens with "Escuchar" already on.
          openDailySummary: async () => {
            const r = await latestDailySummaryAction();
            if (!r.ok || !r.value) return false;
            routerRef.current.push(`/schedules/results/${r.value}?listen=1`);
            return true;
          },
          // ADR-104: "ELISE, mostrate" — only where there is a window to bring up.
          ...(typeof window !== "undefined" && "eliseDesktop" in window
            ? {
                showApp: () =>
                  void (
                    window as { eliseDesktop?: { showApp?: (path?: string) => Promise<void> } }
                  ).eliseDesktop
                    ?.showApp?.()
                    ?.catch(() => undefined),
                // ADR-106: "subí / bajá el volumen" — the computer's.
                adjustVolume: (direction: "up" | "down") =>
                  void (
                    window as {
                      eliseDesktop?: {
                        adjustVolume?: (d: "up" | "down") => Promise<boolean>;
                      };
                    }
                  ).eliseDesktop
                    ?.adjustVolume?.(direction)
                    ?.catch(() => undefined),
              }
            : {}),
          warmAcknowledgements: (language, delivery) =>
            void fetch("/api/voice/speak/warm", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ language, ...(delivery ? { delivery } : {}) }),
            }).catch(() => undefined),
        },
        toPrefs(prefs),
      ),
  );

  useEffect(
    () => controller.update({ send: (text, options) => void send(text, options), cancel: stop }),
    [controller, send, stop],
  );
  useEffect(() => subscribe((event) => controller.onStream(event)), [controller, subscribe]);

  // Server props changed (navigation) or a live change was announced.
  const prefsKey = JSON.stringify(toPrefs(prefs));
  useEffect(() => controller.setPrefs(JSON.parse(prefsKey) as VoicePrefs), [controller, prefsKey]);
  useEffect(() => {
    const on = (e: Event) => controller.setPrefs((e as CustomEvent<Partial<VoicePrefs>>).detail);
    window.addEventListener(VOICE_PREFS_EVENT, on);
    return () => window.removeEventListener(VOICE_PREFS_EVENT, on);
  }, [controller]);

  // What this browser can do for the wake phrase — checked, never assumed.
  const wakeWanted = prefs.wakeEnabled && !deviceWake;
  useEffect(() => {
    if (!wakeWanted) return;
    if (!wake) return controller.setWakeStatus("unsupported");
    let live = true;
    void wake.availability(language).then((a) => {
      if (live)
        controller.setWakeStatus(
          a === "available" ? "ready" : a === "unavailable" ? "unsupported" : "downloadable",
        );
    });
    return () => {
      live = false;
    };
  }, [controller, wake, wakeWanted, language]);

  // The device's wake word hands over here, and learns when the session is busy (one mic).
  useEffect(() => {
    if (!deviceWake) return;
    return onDeviceWake((remainder) => void controller.deviceWake(remainder), deviceWakeFallback);
  }, [controller, deviceWake, deviceWakeFallback]);
  useEffect(
    // The corner Orb tapped: no listening and no answer (like the X).
    () => (deviceWake ? onVoiceEnd(() => controller.cancelAll()) : undefined),
    [controller, deviceWake],
  );
  // ADR-109: "ELISE" said over her reply pauses it, then resumes it or cuts it for a new turn.
  useEffect(
    () =>
      deviceWake
        ? onVoiceControl((c) =>
            c === "pause"
              ? controller.pauseForDevice()
              : c === "resume"
                ? controller.resumeAfterDevice()
                : controller.interruptForDevice(),
          )
        : undefined,
    [controller, deviceWake],
  );
  // A wake word's turn goes out at once: its acknowledgements must be ready before it.
  useEffect(() => {
    if (deviceWake) controller.warmUp();
  }, [controller, deviceWake]);
  // The corner Orb never speaks over the page's conversation (Inicio's phase is the real one).
  const publishes = () => !deviceWakeFallback || !pageHasWake();
  useEffect(() => {
    if (deviceWake && publishes()) publishVoicePhase(state.phase);
  }, [deviceWake, state.phase]); // eslint-disable-line react-hooks/exhaustive-deps -- publishes reads live state
  useEffect(() => () => void (publishes() && publishVoicePhase("idle")), []); // eslint-disable-line react-hooks/exhaustive-deps -- on unmount only

  // Never listen in the background on the web (Desktop's background voice is the person's
  // choice, ADR-095); follow the network honestly.
  useEffect(() => {
    // ADR-104: on ELISE Desktop a hidden window (tray, minimized) is never "the person left": a
    // reply in progress is said in full, with or without the wake word on.
    const desktop = "eliseDesktop" in window;
    const vis = () =>
      !deviceWake && !desktop && controller.visibility(document.visibilityState === "hidden");
    const on = () => controller.network(true);
    const off = () => controller.network(false);
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [controller, deviceWake]);

  // The Orb follows the real audio, read every frame without re-rendering.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      level.current = controller.level();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      level.current = -1;
    };
  }, [controller, level]);

  // Leaving the page ends the session: never a microphone in the background.
  useEffect(() => () => controller.dispose(), [controller]);

  return {
    state,
    start: () => void controller.start(),
    end: () => controller.end(),
    interrupt: () => controller.interrupt(),
    finishNow: () => controller.finishNow(),
    toggleMute: () => controller.toggleMute(),
    /** Downloads the on-device language pack (needs the user's tap). */
    /** Music started or stopped: re-measure the room (ADR-042 §K). */
    ambientChanged: () => controller.ambientChanged(),
    /** The song a turn asked for started: she stops talking over it. */
    musicStarted: () => controller.musicStarted(),
    /** ELISE says this first (a scheduled conversation's narration, ADR-041). */
    narrate: (text: string) => void controller.narrate(text),
    installWake: async () => {
      if (!wake) return;
      controller.setWakeStatus("installing");
      const ok = await wake.install(language);
      controller.setWakeStatus(ok ? "ready" : "failed");
    },
    supported: typeof window === "undefined" || Microphone.supported(),
  };
}

// ── Adaptive voice volume (ADR-049): a per-device preference, like music ducking ──────────

const ADAPTIVE_PREF = "elise.voice.adaptive";

/** "Match my speaking volume": on unless turned off on this device. */
export function adaptiveDeliveryEnabled(): boolean {
  try {
    return typeof window === "undefined" || window.localStorage.getItem(ADAPTIVE_PREF) !== "0";
  } catch {
    return true;
  }
}

export function setAdaptiveDeliveryEnabled(on: boolean) {
  try {
    window.localStorage.setItem(ADAPTIVE_PREF, on ? "1" : "0");
  } catch {
    // Storage unavailable: the default (on) stays.
  }
  window.dispatchEvent(new CustomEvent(VOICE_PREFS_EVENT, { detail: { adaptiveDelivery: on } }));
}

/** Uploads one utterance and follows the transcript as it is recognized. */
async function transcribe(
  blob: Blob,
  onPartial: (text: string) => void,
  signal: AbortSignal,
): Promise<{ text: string; language: VoiceLanguage | null } | null> {
  try {
    const form = new FormData();
    form.append("audio", blob, "speech");
    const res = await fetch("/api/voice/transcribe", { method: "POST", body: form, signal });
    if (!res.ok || !res.body) return null;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as
          | { type: "partial"; text: string }
          | { type: "final"; text: string; language: VoiceLanguage | null }
          | { type: "error" };
        if (e.type === "partial") onPartial(e.text);
        else if (e.type === "final") return { text: e.text, language: e.language };
        else return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function reportTimings(raw: VoiceMarks) {
  // ADR-104: Web and Desktop measured side by side.
  const marks: VoiceMarks = { ...raw, desktop: "eliseDesktop" in window ? 1 : 0 };
  let debug = process.env.NODE_ENV !== "production";
  try {
    debug ||= window.localStorage.getItem("elise.voiceDebug") === "1";
  } catch {
    // Storage unavailable.
  }
  if (debug) {
    const w = window as unknown as { __eliseVoiceTimings?: VoiceMarks[] };
    (w.__eliseVoiceTimings ??= []).push(marks);
    // The turn's lifecycle in order (ADR-028): speech end → ack → tools → Surface → result.
    console.debug(
      `[voice] timeline ${Object.entries(marks)
        .filter((e): e is [string, number] => typeof e[1] === "number")
        .sort((a, b) => a[1] - b[1])
        .map(([k, v]) => `${k} ${v}ms`)
        .join(" → ")}`,
    );
  }
  void fetch("/api/voice/metrics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(marks),
    keepalive: true,
  }).catch(() => {});
}

/**
 * Voice diagnostics (development, or `localStorage["elise.voiceDebug"] = "1"`): one console line
 * per lifecycle event with timings. Never audio, never transcript text.
 */
function voiceTrace() {
  let on = process.env.NODE_ENV !== "production";
  try {
    on ||= window.localStorage.getItem("elise.voiceDebug") === "1";
  } catch {
    // Storage unavailable: production stays quiet.
  }
  return on
    ? (event: string, data?: Record<string, unknown>) =>
        console.debug(`[voice] ${event} ${JSON.stringify(data ?? {})}`)
    : undefined;
}
