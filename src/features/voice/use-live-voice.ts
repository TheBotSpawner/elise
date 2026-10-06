"use client";

import { useEffect, useRef, useState } from "react";

import type { VoicePreferences } from "@/application/auth-context";
import type { ThreadRef } from "@/core/interaction";
import { initialVoice, type VoiceState } from "@/core/voice/session";
import type { SendOptions, StreamListener } from "@/features/chat/use-elise-chat";
import { useI18n } from "@/lib/i18n/client";

import { LiveVoiceSession } from "./live-session";

/**
 * React binding of GPT-Live Voice Mode (ADR-026). Same surface as the legacy `useVoice`, so the
 * dock, the Orb and the Canvas don't care which voice runtime is running.
 */
export function useLiveVoice({
  prefs,
  send,
  stop,
  getThread,
  subscribe,
  level,
}: {
  prefs: VoicePreferences;
  send: (text: string, options?: SendOptions) => Promise<void>;
  stop: () => void;
  getThread: () => ThreadRef | null;
  subscribe: (fn: StreamListener) => () => void;
  level: { current: number };
}) {
  const { locale } = useI18n();
  const language: "es" | "en" = prefs.language === "auto" ? locale : prefs.language;
  const [state, setState] = useState<VoiceState>(() => ({ ...initialVoice, speak: prefs.speak }));
  // The session always calls the latest send/stop/thread.
  const deps = useRef({ send, stop, getThread });
  useEffect(() => {
    deps.current = { send, stop, getThread };
  }, [send, stop, getThread]);
  const session = useRef<LiveVoiceSession | null>(null);

  useEffect(() => {
    const s = new LiveVoiceSession(
      {
        send: (text, options) => deps.current.send(text, options),
        stop: () => deps.current.stop(),
        getThread: () => deps.current.getThread(),
        onState: setState,
        locale: language,
      },
      subscribe,
      prefs.speak,
    );
    session.current = s;
    const vis = () => s.visibility(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", vis);
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      level.current = s.level();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      document.removeEventListener("visibilitychange", vis);
      cancelAnimationFrame(raf);
      level.current = -1;
      // Leaving the page ends Voice Mode: never a microphone (or a billed session) left open.
      s.dispose();
      session.current = null;
    };
  }, [subscribe, language, prefs.speak, level]);

  return {
    state,
    start: () => void session.current?.start(),
    end: () => void session.current?.end(),
    interrupt: () => session.current?.interrupt(),
    finishNow: () => undefined,
    toggleMute: () => session.current?.toggleMute(),
    narrate: (text: string) => void session.current?.narrate(text),
    installWake: async () => undefined,
    supported:
      typeof window === "undefined" ||
      (typeof RTCPeerConnection !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia)),
  };
}
