"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { VoicePreferences } from "@/application/auth-context";
import { Orb } from "@/components/elise/orb/orb";
import { resolveOrbState, voicePhaseOrb } from "@/components/elise/orb/orb-states";
import { useEliseChat } from "@/features/chat/use-elise-chat";
import { useMusic } from "@/features/music/music-view";
import { useI18n } from "@/lib/i18n/client";

import { useVoice } from "./use-voice";

/** Pages with a conversation of their own: a floating Orb there would be a second one. */
const OWN_CONVERSATION = /^\/($|chat\/|onboarding)/;

/**
 * Talk to ELISE from any page: a small Orb in the corner. Voice only — nothing else appears
 * and the page stays as it is; the conversation is the same chat turn as on Inicio (stored
 * there, and Inicio opens it next). Each tap after a finished conversation starts a new one.
 * On Desktop, "ELISE" said while this page is open lands here too.
 */
export function QuickVoice({ prefs }: { prefs: VoicePreferences | undefined }) {
  const pathname = usePathname();
  const [round, setRound] = useState(0);
  // No prefs: a Desktop on a cloud that doesn't send them yet (older deploy).
  if (!prefs?.enabled || OWN_CONVERSATION.test(pathname)) return null;
  return (
    <QuickVoiceSession
      key={round}
      prefs={prefs}
      startNow={round > 0}
      renew={() => setRound((r) => r + 1)}
    />
  );
}

function QuickVoiceSession({
  prefs,
  startNow,
  renew,
}: {
  prefs: VoicePreferences;
  /** Mounted by a tap: start listening right away. */
  startNow: boolean;
  /** A new conversation (a fresh session). */
  renew: () => void;
}) {
  const { t } = useI18n();
  const { send, stop, subscribe, getThread, orbState: chatOrb } = useEliseChat({ headless: true });
  const level = useRef(-1);
  // The browser's wake phrase belongs to Inicio; here a tap (or Desktop's "ELISE") starts it.
  const voice = useVoice({ prefs: { ...prefs, wakeEnabled: false }, send, stop, subscribe, level });
  const phase = voice.state.phase;
  // The song this conversation asked for started: she doesn't talk over it.
  const musicPlaying = Boolean(useMusic().payload?.playing);
  const musicStarted = useRef(voice.musicStarted);
  useEffect(() => {
    musicStarted.current = voice.musicStarted;
  });
  useEffect(() => {
    if (musicPlaying) musicStarted.current();
  }, [musicPlaying]);
  const active = !["idle", "sleeping", "error", "offline"].includes(phase);

  useEffect(() => {
    if (startNow) voice.start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once: the tap that mounted it
  // Other floating actions (Finance's "+") stand to its left.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--quick-voice-space", "76px");
    return () => root.setProperty("--quick-voice-space", "0px");
  }, []);

  if (!voice.supported) return null;
  const state = resolveOrbState([
    ...voicePhaseOrb(phase),
    ...(phase === "error" ? (["error"] as const) : []),
    chatOrb,
  ]);
  return (
    <button
      type="button"
      onClick={() => {
        if (active) voice.end();
        else if (getThread()) renew();
        else voice.start();
      }}
      aria-label={active ? t.voice.end : t.voice.start}
      title={active ? t.voice.end : t.voice.start}
      aria-pressed={active}
      // Centered on Finance's "+" (52 px, 56 px from md); the Orb draws past its 64 px target.
      className="fixed right-4 bottom-[calc(var(--activity-bottom)+var(--activity-music)-6px)] z-30 grid size-16 place-items-center rounded-full opacity-90 transition-[opacity,transform,background-color,box-shadow] duration-200 ease-out hover:scale-105 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none active:scale-90 aria-pressed:scale-110 aria-pressed:bg-[var(--accent-soft)] aria-pressed:opacity-100 aria-pressed:shadow-[0_0_28px_2px_var(--accent-line)] md:right-8 md:bottom-7"
    >
      <Orb state={state} size={88} className="pointer-events-none -m-3" levelSource={level} />
    </button>
  );
}
