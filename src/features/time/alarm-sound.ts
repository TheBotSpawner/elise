"use client";

import { ALARM_LIMITS, ALARM_SOUNDS, isBundledSound, uploadSoundId } from "@/core/timers/alarms";

/**
 * Alarm sounds (ADR-100), played on this device. ELISE's own are synthesized here from their
 * notes (original, nothing to license); an uploaded one plays from a short-lived signed link.
 * A browser only plays sound after the user touched the page (autoplay): `ring` says whether
 * sound really started, so the device reports "playing" or "blocked" — never assumed.
 */

let ctx: AudioContext | null = null;
function context(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  return ctx;
}

/** Unlocks sound on the first touch (shared with the timer chime's context rules). */
export async function unlockAlarmAudio() {
  await context()
    ?.resume()
    .catch(() => undefined);
}

export const audioReady = () => context()?.state === "running";

function cycle(c: AudioContext, key: keyof typeof ALARM_SOUNDS, volume: number, at: number) {
  const s = ALARM_SOUNDS[key];
  const gain = Math.max(0, Math.min(1, volume / 100)) * (s.wave === "square" ? 0.08 : 0.22);
  s.notes.forEach((freq, i) => {
    const t = at + i * s.step;
    const osc = c.createOscillator();
    const env = c.createGain();
    osc.type = s.wave;
    osc.frequency.value = freq;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(gain, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, t + s.step * 2.4);
    osc.connect(env).connect(c.destination);
    osc.start(t);
    osc.stop(t + s.step * 2.5);
  });
}

async function uploadedUrl(id: string): Promise<string | null> {
  const r = await fetch("/api/time/alarms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "soundUrl", id }),
  }).catch(() => null);
  if (!r?.ok) return null;
  return ((await r.json()) as { url?: string }).url ?? null;
}

export interface Ringing {
  /** Sound really started on this device (false: the browser blocked it, or no audio). */
  playing: boolean;
  stop(): void;
}

/**
 * Plays a sound: once (preview) or repeating until stopped — with a local failsafe, so a lost
 * "stop" from the server can never leave it ringing forever.
 */
export async function ring(sound: string, volume: number, loop: boolean): Promise<Ringing> {
  let stopped = false;
  const failsafe = loop ? window.setTimeout(() => stop(), ALARM_LIMITS.ringMs) : 0;
  const cleanups: (() => void)[] = [];
  function stop() {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(failsafe);
    cleanups.forEach((f) => f());
  }

  const upload = uploadSoundId(sound);
  if (upload) {
    const url = await uploadedUrl(upload);
    if (!url || stopped) return { playing: false, stop };
    const audio = new Audio(url);
    audio.loop = loop;
    audio.volume = Math.max(0, Math.min(1, volume / 100));
    cleanups.push(() => {
      audio.pause();
      audio.src = "";
    });
    const playing = await audio.play().then(
      () => true,
      () => false,
    );
    return { playing, stop };
  }

  const key = isBundledSound(sound) ? sound : "brisa";
  const c = context();
  if (!c || c.state !== "running") return { playing: false, stop };
  cycle(c, key, volume, c.currentTime + 0.03);
  if (loop) {
    const every = ALARM_SOUNDS[key].every * 1000;
    const id = window.setInterval(
      () => !stopped && cycle(c, key, volume, c.currentTime + 0.03),
      every,
    );
    cleanups.push(() => window.clearInterval(id));
  }
  return { playing: true, stop };
}
