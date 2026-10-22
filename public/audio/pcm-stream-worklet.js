/**
 * ELISE's speech output (ADR-108): one continuous stream per player. The page pushes PCM as it
 * arrives; this processor plays it sample after sample — no buffer per chunk, no start times, so
 * nothing is ever resampled or positioned per chunk (measured: per-chunk sources in Chromium
 * clicked at boundaries and occasionally rendered a whole chunk with strong high-frequency
 * images). When the queue runs dry it fades the last 2 ms and reports it; when audio comes back
 * it fades in, so an underrun is a short silence, never a click. "flush" (an interruption) fades
 * out over 5 ms and drops what was queued.
 */
const FADE_IN = 48; // 2 ms at 24 kHz
const FADE_OUT = 120; // 5 ms at 24 kHz

class PcmStream extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[]} */
    this.chunks = [];
    this.offset = 0;
    this.queued = 0;
    this.playing = false;
    this.ramp = 0; // samples into a fade-in
    this.flushing = 0; // samples left of a fade-out before dropping everything
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "push") {
        this.chunks.push(m.samples);
        this.queued += m.samples.length;
        if (!this.playing) {
          this.playing = true;
          this.ramp = 0;
          this.port.postMessage({ type: "start", frame: currentFrame });
        }
      } else if (m.type === "flush") {
        this.flushing = this.playing ? FADE_OUT : 0;
        if (!this.flushing) this.clear();
      }
    };
  }

  clear() {
    this.chunks = [];
    this.offset = 0;
    this.queued = 0;
    this.playing = false;
    this.flushing = 0;
  }

  next() {
    const c = this.chunks[0];
    const v = c[this.offset++];
    if (this.offset >= c.length) {
      this.chunks.shift();
      this.offset = 0;
    }
    this.queued--;
    return v;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (!this.playing || this.queued === 0) {
        out[i] = 0;
        continue;
      }
      let v = this.next();
      if (this.flushing) {
        v *= this.flushing / FADE_OUT;
        if (--this.flushing === 0) {
          this.clear();
          this.port.postMessage({ type: "flushed" });
        }
      } else {
        if (this.ramp < FADE_IN) v *= ++this.ramp / FADE_IN;
        // The queue is about to run out: fade, in case more doesn't arrive in time.
        if (this.queued < FADE_IN) v *= this.queued / FADE_IN;
      }
      out[i] = v;
      if (this.playing && this.queued === 0 && !this.flushing) {
        this.playing = false;
        this.port.postMessage({ type: "drained", frame: currentFrame + i });
      }
    }
    return true;
  }
}

registerProcessor("pcm-stream", PcmStream);
