"use client";

import type { WakeAvailability, WakeEngine } from "@/core/voice/device";
import { matchWake, WAKE_LABELS, type WakePhrase } from "@/core/voice/wake";

/**
 * Wake phrase on the device (ADR-017 §7): the browser's own speech recognition with
 * `processLocally = true`, so audio and text never leave the device for detection. It runs
 * only while a voice session sleeps and the page is visible. If the browser can't promise
 * local processing, the engine reports "unavailable" and never runs — voice works as before.
 * Interim text is matched in memory and dropped; nothing before the phrase is kept.
 */

type Availability = "available" | "downloadable" | "downloading" | "unavailable";

interface LocalRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally: boolean;
  phrases?: unknown[];
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
}

interface RecognitionClass {
  new (): LocalRecognition;
  available?(o: { langs: string[]; processLocally: boolean }): Promise<Availability>;
  install?(o: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}

interface PhraseClass {
  new (phrase: string, boost: number): unknown;
}

const LANG = { es: "es-ES", en: "en-US" } as const;

function recognitionClass(): RecognitionClass | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionClass;
    webkitSpeechRecognition?: RecognitionClass;
  };
  // Only the standard class has the on-device API; the prefixed one may use a cloud service.
  const C = w.SpeechRecognition ?? null;
  return C && typeof C.available === "function" ? C : null;
}

export class WebSpeechWakeEngine implements WakeEngine {
  private rec: LocalRecognition | null = null;
  private wanted: Parameters<WakeEngine["start"]>[0] | null = null;
  private restarts = 0;

  get running() {
    return this.rec !== null;
  }

  static supported(): boolean {
    return recognitionClass() !== null;
  }

  async availability(language: "es" | "en"): Promise<WakeAvailability> {
    const C = recognitionClass();
    if (!C?.available) return "unavailable";
    try {
      return await C.available({ langs: [LANG[language]], processLocally: true });
    } catch {
      return "unavailable";
    }
  }

  async install(language: "es" | "en"): Promise<boolean> {
    const C = recognitionClass();
    if (!C?.install) return false;
    try {
      return await C.install({ langs: [LANG[language]], processLocally: true });
    } catch {
      return false;
    }
  }

  start(opts: Parameters<WakeEngine["start"]>[0]) {
    this.stop();
    const C = recognitionClass();
    if (!C) return opts.onError("unavailable");
    this.wanted = opts;
    this.restarts = 0;
    this.run(C);
  }

  private run(C: RecognitionClass) {
    const opts = this.wanted;
    if (!opts) return;
    const rec = new C();
    rec.lang = LANG[opts.language];
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    // Never fall back to a cloud recognizer: local or nothing.
    rec.processLocally = true;
    const Phrase = (window as unknown as { SpeechRecognitionPhrase?: PhraseClass })
      .SpeechRecognitionPhrase;
    if (Phrase) {
      try {
        rec.phrases = [new Phrase(WAKE_LABELS[opts.phrase], 5)];
      } catch {
        // Biasing is optional.
      }
    }
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]!;
        const best = result[0];
        if (!best) continue;
        const m = matchWake(best.transcript, opts.phrase, best.confidence || null);
        // An interim match wakes at once; the rest of a final result becomes the first turn.
        if (m.matched && (result.isFinal || !m.remainder)) {
          const remainder = result.isFinal ? m.remainder : "";
          this.stop();
          opts.onWake(remainder);
          return;
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.stop();
        opts.onError("not_allowed");
      } else if (e.error === "language-not-supported") {
        this.stop();
        opts.onError("unavailable");
      }
      // "no-speech" / "aborted": onend restarts below.
    };
    rec.onend = () => {
      if (this.rec !== rec || !this.wanted) return;
      // Recognition ends on its own after a while; keep listening, but never in a tight loop.
      if (++this.restarts > 200) {
        this.stop();
        opts.onError("failed");
        return;
      }
      setTimeout(() => this.rec === rec && this.wanted && this.run(C), 250);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.stop();
      opts.onError("failed");
    }
  }

  phraseFor(): WakePhrase | null {
    return this.wanted?.phrase ?? null;
  }

  stop() {
    const rec = this.rec;
    this.rec = null;
    this.wanted = null;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try {
        rec.abort();
      } catch {
        // already stopped
      }
    }
  }
}
