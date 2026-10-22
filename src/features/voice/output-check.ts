"use client";

import {
  classifyBeep,
  detectBeeps,
  type AudioEvent,
  type BeepOrigin,
} from "@/core/voice/beep-detect";

import { soundLogSince } from "./sound-log";

/**
 * ELISE Desktop's voice output check (ADR-108): records what the computer actually plays —
 * system audio, never the microphone or the screen — for a short while, finds beeps, clicks and
 * high-pitched bursts in it, and says where each came from, by comparing with what ELISE itself
 * played at that moment (its chimes, and its generated voice analyzed the same way).
 *
 * Only on the person's click; the main process allows that one capture for a few seconds. The
 * recording stays in this page's memory: it is downloaded only if the person asks.
 */

export interface FoundBeep extends AudioEvent {
  origin: BeepOrigin;
}

export interface OutputCheck {
  seconds: number;
  rate: number;
  beeps: FoundBeep[];
  /** What ELISE did meanwhile, for the report. */
  elise: { chimes: number; speechSeconds: number; events: { at: number; kind: string }[] };
  audio: Float32Array;
}

interface AudioDataLike {
  numberOfFrames: number;
  numberOfChannels: number;
  sampleRate: number;
  copyTo(dest: Float32Array, opts: { planeIndex: number; format: "f32-planar" }): void;
  close(): void;
}
type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => {
  readable: ReadableStream<AudioDataLike>;
};

export const canCheckOutput = () =>
  typeof window !== "undefined" &&
  Boolean(
    (window as { eliseDesktop?: { armOutputCapture?: unknown } }).eliseDesktop?.armOutputCapture,
  ) &&
  "MediaStreamTrackProcessor" in window;

export async function checkOutput(
  seconds: number,
  onProgress: (elapsed: number) => void,
): Promise<OutputCheck> {
  const bridge = (window as { eliseDesktop?: { armOutputCapture?: () => Promise<void> } })
    .eliseDesktop;
  await bridge?.armOutputCapture?.();
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  // The screen is never kept: only its audio (the system's output) is read.
  stream.getVideoTracks().forEach((t) => t.stop());
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("no system audio");
  }
  const Processor = (window as { MediaStreamTrackProcessor?: TrackProcessorCtor })
    .MediaStreamTrackProcessor!;
  const reader = new Processor({ track }).readable.getReader();
  const parts: Float32Array[] = [];
  let rate = 48_000;
  let total = 0;
  let startedAt = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      if (!startedAt) startedAt = performance.now();
      rate = value.sampleRate;
      // Mono: the channels mixed.
      const mono = new Float32Array(value.numberOfFrames);
      const ch = new Float32Array(value.numberOfFrames);
      for (let c = 0; c < value.numberOfChannels; c++) {
        value.copyTo(ch, { planeIndex: c, format: "f32-planar" });
        for (let i = 0; i < ch.length; i++) mono[i]! += ch[i]! / value.numberOfChannels;
      }
      value.close();
      parts.push(mono);
      total += mono.length;
      onProgress(total / rate);
      if (total >= seconds * rate) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    stream.getTracks().forEach((t) => t.stop());
  }
  const audio = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    audio.set(p, at);
    at += p.length;
  }
  const beeps = detectBeeps(audio, rate);
  // ELISE's own sounds on the recording's clock (seconds from its first sample).
  const log = soundLogSince(startedAt - 1000);
  const rel = (t: number) => (t - startedAt) / 1000;
  const chimes = log.events.filter((e) => e.kind.startsWith("chime:")).map((e) => rel(e.at));
  const clips = log.clips.map((c) => ({
    start: rel(c.at),
    end: rel(c.at) + c.pcm.length / c.rate,
    events: detectBeeps(
      Float32Array.from(c.pcm, (v) => v / 32768),
      c.rate,
    ),
  }));
  return {
    seconds: total / rate,
    rate,
    beeps: beeps.map((b) => ({ ...b, origin: classifyBeep(b, { chimes, clips }) })),
    elise: {
      chimes: chimes.length,
      speechSeconds: +clips.reduce((s, c) => s + (c.end - c.start), 0).toFixed(1),
      events: log.events.map((e) => ({ at: +rel(e.at).toFixed(2), kind: e.kind })),
    },
    audio,
  };
}

/** The report (and, only if asked, the recording) as files. */
export function downloadOutputCheck(check: OutputCheck, withAudio: boolean) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const save = (blob: Blob, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const { audio, ...report } = check;
  save(
    new Blob([JSON.stringify({ version: 1, ...report }, null, 2)], { type: "application/json" }),
    `elise-salida-${stamp}.json`,
  );
  if (!withAudio) return;
  const pcm = Int16Array.from(audio, (v) =>
    Math.max(-32768, Math.min(32767, Math.round(v * 32767))),
  );
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  h.setUint32(4, 36 + pcm.byteLength, true);
  w(8, "WAVEfmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, check.rate, true);
  h.setUint32(28, check.rate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  w(36, "data");
  h.setUint32(40, pcm.byteLength, true);
  save(new Blob([h.buffer, pcm.buffer], { type: "audio/wav" }), `elise-salida-${stamp}.wav`);
}
