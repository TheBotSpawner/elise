/**
 * A minimal client for Vosk's recognizer worker (vosk-browser's worker protocol, ADR-095). The
 * worker runs from its own file, /vosk-worker.js, under its own CSP; this page only exchanges
 * messages with it — audio frames in, words out. Nothing here touches the network: the model is
 * loaded from the app itself.
 */

/** A recognized word with its time (seconds since the recognizer started). */
export interface TimedWord {
  word: string;
  /** The recognizer's confidence, 0–1 (ADR-108: weak finals don't wake). */
  conf: number;
  start: number;
  end: number;
}

interface RecognizerHandlers {
  onPartial: (text: string) => void;
  onResult: (text: string, words: TimedWord[]) => void;
}

type ServerMessage =
  | { event: "load"; result: boolean }
  | { event: "error"; recognizerId?: string; error: string }
  | { event: "partialresult"; recognizerId: string; result: { partial: string } }
  | { event: "result"; recognizerId: string; result: { text: string; result?: TimedWord[] } };

export interface VoskRecognizer {
  /** 16-bit range floats, as Kaldi expects (the page sends -1..1 audio). */
  accept(samples: Float32Array, sampleRate: number): void;
  remove(): void;
}

export class VoskWorker {
  private readonly worker: Worker;
  private readonly handlers = new Map<string, RecognizerHandlers>();
  readonly ready: Promise<void>;

  constructor(modelUrl: string) {
    this.worker = new Worker("/vosk-worker.js");
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<ServerMessage>) => {
        const m = e.data;
        if (!m) return;
        if (m.event === "load") return m.result ? resolve() : reject(new Error("model"));
        if (m.event === "error" && !m.recognizerId) return reject(new Error("worker"));
        if (m.event === "partialresult")
          this.handlers.get(m.recognizerId)?.onPartial(m.result.partial);
        else if (m.event === "result")
          this.handlers.get(m.recognizerId)?.onResult(m.result.text, m.result.result ?? []);
      };
      this.worker.onerror = () => reject(new Error("worker"));
    });
    this.worker.postMessage({ action: "set", key: "logLevel", value: -1 });
    this.worker.postMessage({ action: "load", modelUrl });
  }

  recognizer(sampleRate: number, grammar: string[], handlers: RecognizerHandlers): VoskRecognizer {
    const id = crypto.randomUUID();
    this.handlers.set(id, handlers);
    this.worker.postMessage({
      action: "create",
      recognizerId: id,
      sampleRate,
      grammar: JSON.stringify(grammar),
    });
    // Word times: where the wake word started, so nothing said after it is lost.
    this.worker.postMessage({ action: "set", recognizerId: id, key: "words", value: true });
    return {
      accept: (samples, rate) => {
        const data = samples.map((v) => v * 0x8000);
        this.worker.postMessage(
          { action: "audioChunk", recognizerId: id, data, sampleRate: rate },
          { transfer: [data.buffer] },
        );
      },
      remove: () => {
        this.handlers.delete(id);
        this.worker.postMessage({ action: "remove", recognizerId: id });
      },
    };
  }

  terminate() {
    this.worker.postMessage({ action: "terminate" });
    this.worker.terminate();
  }
}
