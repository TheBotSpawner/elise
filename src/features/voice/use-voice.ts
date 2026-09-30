"use client";

import { useEffect, useState } from "react";

import type { VoicePreferences } from "@/application/auth-context";
import type { ChatStreamEvent } from "@/application/chat-protocol";
import type { VoiceLanguage } from "@/core/voice/providers";
import { initialVoice, type VoiceState } from "@/core/voice/session";
import type { SendOptions } from "@/features/chat/use-elise-chat";

import { Microphone, MicError } from "./microphone";
import { SpeechPlayer } from "./speech-player";
import { VoiceController, type VoiceMarks } from "./voice-controller";

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
  const [state, setState] = useState<VoiceState>({ ...initialVoice, speak: prefs.speak });
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
        },
        prefs.speak,
      ),
  );

  useEffect(
    () => controller.update({ send: (text, options) => void send(text, options) }),
    [controller, send],
  );
  useEffect(() => subscribe((event) => controller.onStream(event)), [controller, subscribe]);

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
