"use client";

import { useEffect, useState } from "react";

import type { VoicePreferences } from "@/application/auth-context";
import type { ChatStreamEvent } from "@/application/chat-protocol";
import type { VoiceLanguage } from "@/core/voice/providers";
import { initialVoice, type VoiceState } from "@/core/voice/session";
import type { SendOptions } from "@/features/chat/use-elise-chat";
import { useI18n } from "@/lib/i18n/client";

import { Microphone, MicError } from "./microphone";
import { SpeechPlayer } from "./speech-player";
import {
  VOICE_PREFS_EVENT,
  VoiceController,
  type VoiceMarks,
  type VoicePrefs,
} from "./voice-controller";
import { WebSpeechWakeEngine } from "./wake-engine";

type Listener = (event: ChatStreamEvent | { type: "finished"; failed: boolean }) => void;

/** React binding of the voice session: browser audio in, the chat stream out. */
export function useVoice({
  prefs,
  send,
  subscribe,
  level,
}: {
  prefs: VoicePreferences;
  send: (text: string, options?: SendOptions) => Promise<void>;
  subscribe: (fn: Listener) => () => void;
  /** Shared with the Orb: the live input or output amplitude. */
  level: { current: number };
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
  });
  const [wake] = useState(() =>
    typeof window !== "undefined" && WebSpeechWakeEngine.supported()
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
        },
        toPrefs(prefs),
      ),
  );

  useEffect(
    () => controller.update({ send: (text, options) => void send(text, options) }),
    [controller, send],
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
  const wakeWanted = prefs.wakeEnabled;
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

  // Never listen in the background; follow the network honestly.
  useEffect(() => {
    const vis = () => controller.visibility(document.visibilityState === "hidden");
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
  }, [controller]);

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
    installWake: async () => {
      if (!wake) return;
      controller.setWakeStatus("installing");
      const ok = await wake.install(language);
      controller.setWakeStatus(ok ? "ready" : "failed");
    },
    supported: typeof window === "undefined" || Microphone.supported(),
  };
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

function reportTimings(marks: VoiceMarks) {
  if (process.env.NODE_ENV !== "production") {
    const w = window as unknown as { __eliseVoiceTimings?: VoiceMarks[] };
    (w.__eliseVoiceTimings ??= []).push(marks);
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
