/**
 * Streaming sample-rate conversion for the wake word (ADR-108): the microphone delivers its
 * native rate (48 kHz, 44.1 kHz…), the recognizer wants 16 kHz. A windowed-sinc low-pass at the
 * input rate (no aliasing of what the recognizer can't represent), then linear interpolation —
 * the same design as the evaluation's simulator, so what was measured is what runs. State
 * carries across chunks: chunk boundaries never click or skip.
 */
export class StreamResampler {
  private readonly h: Float32Array;
  private readonly step: number;
  private history: Float32Array;
  /** The last filtered sample of the previous chunk (interpolation across the boundary). */
  private last = 0;
  /** Position of the next output sample, in input samples from the current chunk's start - 1. */
  private pos = 1;

  constructor(
    readonly from: number,
    readonly to: number,
    taps = 63,
  ) {
    this.step = from / to;
    const cutoff = (0.45 * Math.min(from, to)) / from;
    const h = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const n = i - (taps - 1) / 2;
      const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
      const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1));
      h[i] = sinc * hann;
      sum += h[i]!;
    }
    for (let i = 0; i < taps; i++) h[i]! /= sum;
    this.h = h;
    this.history = new Float32Array(taps - 1);
  }

  push(x: Float32Array): Float32Array {
    if (this.from === this.to) return x;
    const taps = this.h.length;
    const buf = new Float32Array(this.history.length + x.length);
    buf.set(this.history);
    buf.set(x, this.history.length);
    // Filtered samples of this chunk (causal FIR: a constant group delay, harmless here).
    const y = new Float32Array(x.length + 1);
    y[0] = this.last;
    for (let n = 0; n < x.length; n++) {
      let acc = 0;
      for (let k = 0; k < taps; k++) acc += this.h[k]! * buf[n + taps - 1 - k]!;
      y[n + 1] = acc;
    }
    this.history = buf.slice(buf.length - (taps - 1));
    this.last = y[x.length]!;
    const out: number[] = [];
    while (this.pos <= x.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      out.push(frac === 0 ? y[i]! : y[i]! + (y[i + 1]! - y[i]!) * frac);
      this.pos += this.step;
    }
    this.pos -= x.length;
    return Float32Array.from(out);
  }
}
