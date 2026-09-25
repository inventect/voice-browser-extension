/**
 * AudioWorklet (local addition): microphone Float32 → PCM16 little-endian at 16 kHz, posted to
 * the side panel in 100 ms chunks (1600 samples) together with the chunk's peak level.
 * If the AudioContext does not run at 16 kHz, input is decimated with a box filter (averaging),
 * which is enough anti-aliasing for speech. Copied verbatim to dist/ (not bundled).
 */
class VbPcm16 extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.ratio = o.inRate && o.outRate ? o.inRate / o.outRate : 1;
    this.size = 1600;
    this.buf = new Int16Array(this.size);
    this.n = 0;
    this.peak = 0;
    this.acc = 0; // resampler: running sum of the current output window
    this.cnt = 0; // samples in the current window
    this.pos = 0; // fractional input position inside the window
  }
  push(s) {
    s = Math.max(-1, Math.min(1, s));
    const a = s < 0 ? -s : s;
    if (a > this.peak) this.peak = a;
    this.buf[this.n++] = s < 0 ? s * 32768 : s * 32767;
    if (this.n === this.size) {
      this.port.postMessage({ pcm: this.buf.buffer, peak: this.peak }, [this.buf.buffer]);
      this.buf = new Int16Array(this.size);
      this.n = 0;
      this.peak = 0;
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i]);
      return true;
    }
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.cnt += 1;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.push(this.acc / this.cnt);
        this.pos -= this.ratio;
        this.acc = 0;
        this.cnt = 0;
      }
    }
    return true;
  }
}
registerProcessor("vb-pcm16", VbPcm16);
