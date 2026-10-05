"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SpeechPlayer } from "@/features/voice/speech-player";

export interface NarrationLine {
  segment: string;
  text: string;
}

/**
 * Plays a scheduled run's script in ELISE's voice, one segment at a time, so the segment on
 * screen is always the one being said (ADR-039). The next line is synthesized while the current
 * one plays, so there's no dead air between cards. If ELISE's voice isn't available, the
 * browser's own speech engine reads the rest (nothing leaves the device for that).
 */
export function useNarration(lines: readonly NarrationLine[], language: "es" | "en") {
  const [active, setActive] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const player = useRef<SpeechPlayer | null>(null);
  // Every play() starts a new generation: callbacks from a stopped one are ignored.
  const generation = useRef(0);

  const stop = useCallback(() => {
    generation.current++;
    player.current?.stop();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setPlaying(false);
    setActive(null);
  }, []);

  useEffect(
    () => () => {
      generation.current++;
      player.current?.close();
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    },
    [],
  );

  const finish = useCallback((gen: number) => {
    if (gen !== generation.current) return;
    setPlaying(false);
    setActive(null);
  }, []);

  const browser = useCallback(
    (from: number, gen: number) => {
      const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
      if (!synth) return finish(gen);
      synth.cancel();
      lines.slice(from).forEach((line, i, rest) => {
        const u = new SpeechSynthesisUtterance(line.text);
        u.lang = language === "es" ? "es-AR" : "en-US";
        u.onstart = () => gen === generation.current && setActive(line.segment);
        if (i === rest.length - 1) u.onend = () => finish(gen);
        synth.speak(u);
      });
    },
    [finish, language, lines],
  );

  /** Must be called from a user gesture (a tap on Escuchar): browsers allow audio then. */
  const play = useCallback(
    (from = 0) => {
      stop();
      const gen = generation.current;
      setPlaying(true);
      let p: SpeechPlayer;
      try {
        p = player.current ??= new SpeechPlayer();
      } catch {
        return browser(from, gen);
      }
      let index = from;
      let failed = false;
      const say = (i: number) => {
        if (gen !== generation.current) return;
        const line = lines[i];
        if (!line) return finish(gen);
        index = i;
        setActive(line.segment);
        const next = lines[i + 1];
        if (next) p.prepare(next.text, language);
        p.speak(line.text, language);
      };
      p.onError = () => {
        if (gen !== generation.current || failed) return;
        // ELISE's voice is unavailable: the browser continues from this line.
        failed = true;
        p.stop();
        browser(index, gen);
      };
      p.onIdle = () => {
        if (!failed) say(index + 1);
      };
      say(from);
    },
    [browser, finish, language, lines, stop],
  );

  return { active, playing, play, stop };
}
