// Recoge el audio (ya en mono y a 16 kHz) en tramas de 100 ms y las envía
// al documento offscreen.
const FRAME_SAMPLES = 1600;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const count = Math.min(channel.length - offset, FRAME_SAMPLES - this.filled);
        this.frame.set(channel.subarray(offset, offset + count), this.filled);
        this.filled += count;
        offset += count;
        if (this.filled === FRAME_SAMPLES) {
          this.port.postMessage(this.frame, [this.frame.buffer]);
          this.frame = new Float32Array(FRAME_SAMPLES);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
