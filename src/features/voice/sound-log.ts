"use client";

/**
 * Voice diagnostics (ADR-104): what ELISE herself sent to the speakers in the last 90 s — her
 * spoken audio exactly as it was scheduled (overlaps included), and every sound she synthesized
 * (wake chime, completion tone, alarm…) with its time. Memory only; it leaves the page only
 * when the person downloads it, to find where a sound they heard came from: in this audio
 * (ELISE / the speech provider) or not (the system or the device).
 */

const WINDOW_MS = 90_000;

interface Clip {
  /** Wall clock (performance.now) when it starts playing. */
  at: number;
  rate: number;
  pcm: Int16Array;
}
interface Entry {
  at: number;
  kind: string;
  detail?: string;
}

const clips: Clip[] = [];
const events: Entry[] = [];

function prune(now: number) {
  while (
    clips.length &&
    clips[0]!.at + (clips[0]!.pcm.length / clips[0]!.rate) * 1000 < now - WINDOW_MS
  )
    clips.shift();
  while (events.length && events[0]!.at < now - WINDOW_MS) events.shift();
}

/** Spoken audio about to play `delaySec` from now (a copy: the caller's buffer may be reused). */
export function logAudio(pcm: Int16Array, rate: number, delaySec: number) {
  const now = performance.now();
  clips.push({ at: now + Math.max(0, delaySec) * 1000, rate, pcm: pcm.slice() });
  prune(now);
}

/** A sound or a step ELISE produced: "chime:wake", "segment", "completion"… */
export function logSound(kind: string, detail?: string) {
  const now = performance.now();
  events.push({ at: now, kind, ...(detail ? { detail: detail.slice(0, 300) } : {}) });
  prune(now);
}

function wav(samples: Int16Array, rate: number): Blob {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  h.setUint32(4, 36 + samples.byteLength, true);
  w(8, "WAVEfmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  w(36, "data");
  h.setUint32(40, samples.byteLength, true);
  return new Blob([h.buffer, samples.buffer as ArrayBuffer], { type: "audio/wav" });
}

/** The window as one WAV (clips mixed on their timeline) and a JSON log, timed from its start. */
export function exportSoundLog(): { audio: Blob; log: Blob } | null {
  prune(performance.now());
  if (!clips.length && !events.length) return null;
  const rate = clips[0]?.rate ?? 24_000;
  const start = Math.min(...clips.map((c) => c.at), ...events.map((e) => e.at));
  const end = Math.max(
    ...clips.map((c) => c.at + (c.pcm.length / c.rate) * 1000),
    ...events.map((e) => e.at),
  );
  const mix = new Float32Array(Math.ceil(((end - start) / 1000) * rate) + 1);
  for (const c of clips) {
    const offset = Math.round(((c.at - start) / 1000) * rate);
    const step = c.rate / rate;
    for (let i = 0; i * step < c.pcm.length && offset + i < mix.length; i++)
      mix[offset + i]! += c.pcm[Math.floor(i * step)]! / 32768;
  }
  const out = Int16Array.from(mix, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
  const log = {
    note: "Seconds from the start of the recording. 'segment' = a spoken line (provider:model:source); 'chime:*'/'completion'/'alarm' = sounds ELISE synthesized.",
    events: events.map((e) => ({
      at: +((e.at - start) / 1000).toFixed(2),
      kind: e.kind,
      ...(e.detail ? { detail: e.detail } : {}),
    })),
    clips: clips.map((c) => ({
      at: +((c.at - start) / 1000).toFixed(2),
      seconds: +(c.pcm.length / c.rate).toFixed(2),
    })),
  };
  return {
    audio: wav(out, rate),
    log: new Blob([JSON.stringify(log, null, 2)], { type: "application/json" }),
  };
}

export function downloadSoundLog(): boolean {
  const files = exportSoundLog();
  if (!files) return false;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  for (const [blob, name] of [
    [files.audio, `elise-voz-${stamp}.wav`],
    [files.log, `elise-voz-${stamp}.json`],
  ] as const) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }
  return true;
}
