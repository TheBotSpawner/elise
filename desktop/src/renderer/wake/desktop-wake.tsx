import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { voicePhaseOrb } from "@/components/elise/orb/orb-states";
import type { WakeControl, WakeReport } from "@/core/platform/platform";
import type { VoicePhase } from "@/core/voice/session";
import { sessionCommand } from "@/core/voice/session-control";
import { findWake, matchWake } from "@/core/voice/wake";
import { asksToShow, WAKE_MODELS, type DetectorState } from "@/core/voice/wake-detector";
import { musicStore } from "@/features/music/store";
import {
  DeviceWakeContext,
  deviceMayInterrupt,
  deviceMayListen,
  onVoicePhase,
  publishDeviceCapture,
  requestDeviceWake,
  requestVoiceControl,
  requestVoiceEnd,
} from "@/features/voice/device-wake";
import { logSound, soundLogSince } from "@/features/voice/sound-log";

import { VoskWakeDetector, wav } from "./vosk-detector";

/**
 * "ELISE" in the background (ADR-095): this computer listens locally for the word while the
 * person works in any other app — window hidden, minimized or in the tray — and hands what they
 * said to the app's one voice session. It never shows, focuses or raises the window; only "abrí
 * ELISE" does. Listening needs the person's setting; a pause, a locked screen, a conversation in
 * progress or a missing microphone release the microphone at once.
 */

const MODEL = WAKE_MODELS[0]!;
/** A microphone that failed (unplugged, denied) is tried again after a while, not in a loop. */
const RETRY_MS = 30_000;
/** After a hand-off, the session takes the microphone; if it doesn't, listen again. */
const HANDOFF_MS = 6_000;
/** ADR-109: ELISE said her own name this recently — "ELISE" heard now is her voice, not a call. */
const OWN_NAME_MS = 6_000;

/** Whether ELISE's own recent lines contain her name (her echo must never cut her off). */
const saidOwnName = () =>
  soundLogSince(performance.now() - OWN_NAME_MS).events.some(
    (e) => e.kind === "segment" && /\belis/i.test(e.detail ?? ""),
  );

const OFF: WakeControl = { enabled: false, paused: false, suspended: false, chime: true };

/**
 * One output for ELISE's own short sounds (ADR-108): a context per chime opened and closed an
 * audio stream on the device each time, next to the voice. Created on first use, kept.
 */
let chimes: AudioContext | null = null;

/** A short, quiet two-note sound: heard, not announced. */
function tone(kind: "wake" | "error") {
  logSound(`chime:${kind}`);
  try {
    chimes ??= new AudioContext();
    const ctx = chimes;
    void ctx.resume().catch(() => undefined);
    const t = ctx.currentTime + 0.01;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (kind === "wake" ? 0.26 : 0.35));
    gain.connect(ctx.destination);
    const notes = kind === "wake" ? [880, 1318.5] : [330, 262];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(f, t + i * 0.07);
      o.connect(gain);
      o.start(t + i * 0.07);
      o.stop(t + 0.36);
      o.onended = () => o.disconnect();
    });
    setTimeout(() => gain.disconnect(), 600);
  } catch {
    // No audio output: nothing to play.
  }
}

/** What was said after the word, from the existing transcription endpoint (never stored). */
async function transcribe(blob: Blob): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("audio", blob, "speech.wav");
    const res = await fetch("/api/voice/transcribe", { method: "POST", body: form });
    if (!res.ok) return null;
    const lines = (await res.text()).split("\n").filter(Boolean);
    for (const line of lines.reverse()) {
      const e = JSON.parse(line) as { type: string; text?: string };
      if (e.type === "final") return e.text ?? "";
      if (e.type === "error") return null;
    }
    return null;
  } catch {
    return null;
  }
}

// What the listener reports, for the tray (main) and for Settings (this renderer).
let current: WakeReport = "off";
const reportListeners = new Set<() => void>();
const report = (s: WakeReport) => {
  if (s !== current) {
    current = s;
    reportListeners.forEach((l) => l());
  }
  void window.eliseDesktop?.reportWake?.(s).catch(() => undefined);
};

/** The listener's real state (Settings shows it; never a promise it isn't keeping). */
export function useWakeReport(): WakeReport {
  return useSyncExternalStore(
    (l) => (reportListeners.add(l), () => reportListeners.delete(l)),
    () => current,
    () => current,
  );
}

function reportFor(
  control: WakeControl,
  phase: VoicePhase,
  detector: DetectorState,
  handingOff: boolean,
): WakeReport {
  if (!control.enabled) return "off";
  if (control.paused || control.suspended) return "paused";
  // From the word on (its words still being transcribed) it is a conversation.
  if (handingOff || !deviceMayListen(phase)) return "in_conversation";
  if (detector === "listening" || detector === "capturing") return "listening";
  if (detector === "no_microphone" || detector === "mic_denied" || detector === "model_failed")
    return detector;
  return "starting";
}

export function DesktopWake({ children }: { children: ReactNode }) {
  const [control, setControl] = useState<WakeControl>(OFF);

  // The control comes from the main process: the person's setting, the tray's pause, the lock.
  useEffect(() => {
    const bridge = window.eliseDesktop;
    if (!bridge?.getWakeControl) return;
    void bridge.getWakeControl().then(setControl);
    const offEnd = bridge.onVoiceEnd?.(requestVoiceEnd);
    const offControl = bridge.onWakeControl(setControl);
    return () => {
      offEnd?.();
      offControl();
    };
  }, []);

  const controlRef = useRef(control);
  const syncRef = useRef<() => void>(() => undefined);
  // A pause, a lock or the setting turned off releases the microphone at once.
  useEffect(() => {
    controlRef.current = control;
    syncRef.current();
  }, [control]);

  useEffect(() => {
    const detector = new VoskWakeDetector();
    let phase: VoicePhase = "idle";
    let handingOff = false;
    let handoffTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    /** Whether this capture's chime already played (ADR-108). */
    let chimed = false;
    /** ADR-109: this capture began over ELISE's reply (paused until it's settled). */
    let interrupting = false;
    /** ADR-109: this capture is her own voice saying her name: dropped. */
    let ignoring = false;
    /** The paused reply continues (it wasn't a call, or the request didn't need it to stop). */
    const resumeReply = () => {
      if (interrupting) requestVoiceControl("resume");
      interrupting = false;
    };

    const update = () => report(reportFor(controlRef.current, phase, detector.state, handingOff));
    const failed = () =>
      detector.state === "no_microphone" ||
      detector.state === "mic_denied" ||
      detector.state === "model_failed";

    const sync = () => {
      if (disposed) return;
      const c = controlRef.current;
      const on = c.enabled && !c.paused && !c.suspended;
      if (!on) {
        if (detector.state !== "stopped" && !failed()) detector.stop();
        return update();
      }
      // A conversation has the floor: the word isn't listened for (the microphone stays open) —
      // except while ELISE answers, when "ELISE" may cut in (ADR-109).
      if ((!deviceMayListen(phase) && !deviceMayInterrupt(phase)) || handingOff) {
        detector.hold();
        return update();
      }
      if (failed() && Date.now() < retryAt) return update();
      if (detector.state === "stopped" || detector.state === "held" || failed()) {
        void detector.start({
          model: MODEL,
          // ADR-104: through ELISE's own music, without having to shout.
          listenThrough: () => Boolean(musicStore.get().payload?.playing),
          // ADR-109: over her reply, the capture starts at the word, not at her own voice before it.
          overReply: () => deviceMayInterrupt(phase),
          onState: (s) => {
            if (s === "no_microphone" || s === "mic_denied" || s === "model_failed") {
              retryAt = Date.now() + RETRY_MS;
              if (retryTimer) clearTimeout(retryTimer);
              retryTimer = setTimeout(sync, RETRY_MS + 100);
            }
            update();
          },
          onDetected: (decision) => {
            // ADR-109: over her own reply — unless she just said her own name (her echo) — her
            // voice freezes at once while the words are checked.
            interrupting = deviceMayInterrupt(phase);
            if (interrupting && saidOwnName()) {
              logSound("wake:candidate", "own name in her reply, ignored");
              ignoring = true;
              return;
            }
            if (interrupting) requestVoiceControl("pause");
            // ADR-108: a validated candidate chimes now; a guarded one (after false alarms, or
            // with music) stays silent until the transcription confirms it was a call.
            chimed = !decision.guarded;
            if (chimed && controlRef.current.chime) tone("wake");
            // The page's Orb listens with the person from the word on (ADR-104).
            publishDeviceCapture("listening");
          },
          onCaptured: (capture) => void handOff(capture),
        });
      }
      update();
    };

    const finishHandOff = () => {
      // Whatever didn't settle it (offline, a failed transcription, a dropped capture): the
      // reply that was paused for it goes on.
      resumeReply();
      publishDeviceCapture(null);
      handingOff = false;
      if (handoffTimer) clearTimeout(handoffTimer);
      handoffTimer = null;
      sync();
    };

    async function handOff(
      capture: Parameters<Parameters<VoskWakeDetector["start"]>[0]["onCaptured"]>[0],
    ) {
      if (ignoring) {
        ignoring = false;
        interrupting = false;
        return sync();
      }
      // The session takes the conversation: stop listening for the word (the mic stays open).
      handingOff = true;
      publishDeviceCapture("thinking");
      detector.hold();
      report("in_conversation");
      if (!navigator.onLine) {
        tone("error");
        return finishHandOff();
      }
      let remainder = "";
      // Development traces: sizes and flags, never words or audio.
      console.debug("[wake] captured", {
        seconds: +(capture.audio.length / capture.sampleRate).toFixed(1),
        speechAfter: capture.speechAfter,
      });
      if (capture.speechAfter) {
        const text = await transcribe(wav(capture.audio, capture.sampleRate));
        if (text !== null) {
          // Over her reply, the capture may begin with her own voice: the name is found where
          // it is (ADR-109); otherwise it must open what was said.
          const m = interrupting ? findWake(text, "elise") : matchWake(text, "elise");
          console.debug("[wake] transcribed", {
            matched: m.matched,
            remainderChars: m.remainder.length,
          });
          // The words didn't start with "ELISE" (someone said it mid-sentence, or it wasn't
          // the word): no conversation starts, and the next candidates need more evidence.
          if (!m.matched && text.trim()) {
            detector.outcome("rejected");
            return finishHandOff();
          }
          remainder = m.remainder;
        }
      }
      // A real call: the guard lifts, and a guarded candidate chimes now.
      detector.outcome("confirmed");
      if (!chimed && controlRef.current.chime) tone("wake");
      chimed = true;
      // ADR-102: "ELISE, dejá de escuchar" — nothing starts (and a session open ends);
      // "desactivá la activación por voz" also turns the setting off (Settings or the tray
      // turn it back on).
      const command = sessionCommand(remainder);
      // ADR-104: "ELISE, mostrate" — the window to the front, and nothing else starts (a reply
      // that was paused for it goes on: finishHandOff resumes it).
      if (command === "show") {
        void window.eliseDesktop?.showApp?.();
        return finishHandOff();
      }
      // ADR-106: "ELISE, bajá el volumen" — the computer's volume; a paused reply goes on.
      if (command === "volume_up" || command === "volume_down") {
        void window.eliseDesktop
          ?.adjustVolume?.(command === "volume_up" ? "up" : "down")
          .catch(() => undefined);
        return finishHandOff();
      }
      if (command) {
        console.debug("[wake] session command", { command });
        // "ELISE, basta": the reply that was paused stops for good.
        if (interrupting) requestVoiceControl("interrupt");
        interrupting = false;
        if (command === "disable_wake")
          void window.eliseDesktop?.setPreferences?.({ wakeWord: false }).catch(() => undefined);
        requestVoiceEnd();
        return finishHandOff();
      }
      // ADR-109: a new request over her reply — that reply ends, this one starts.
      if (interrupting) requestVoiceControl("interrupt");
      interrupting = false;
      // Only an explicit "abrí ELISE" / "mostrame esto en pantalla" shows the window.
      if (asksToShow(remainder)) void window.eliseDesktop?.showApp?.("/");
      // Inicio's session takes it, or on any other page the floating Orb's: the page stays.
      requestDeviceWake(remainder);
      // From here the session's own phase drives the Orb.
      publishDeviceCapture(null);
      handoffTimer = setTimeout(finishHandOff, HANDOFF_MS);
    }

    const offPhase = onVoicePhase((p) => {
      phase = p;
      // The corner Orb follows the conversation (states only, never words).
      const orb = voicePhaseOrb(p)[0];
      if (orb)
        void window.eliseDesktop
          ?.reportVoiceOrb?.(
            orb === "listening" || orb === "user_speaking" || orb === "speaking" ? orb : "thinking",
          )
          .catch(() => undefined);
      // The session took over (or ended): the hand-off is done.
      if (handingOff && !interrupting && !deviceMayListen(p)) {
        handingOff = false;
        if (handoffTimer) clearTimeout(handoffTimer);
      }
      sync();
    });
    syncRef.current = sync;
    const tick = setInterval(sync, 1000);
    sync();
    return () => {
      disposed = true;
      offPhase();
      clearInterval(tick);
      if (retryTimer) clearTimeout(retryTimer);
      if (handoffTimer) clearTimeout(handoffTimer);
      detector.stop();
      report("off");
    };
  }, []);

  return (
    <DeviceWakeContext.Provider value={control.enabled}>{children}</DeviceWakeContext.Provider>
  );
}
