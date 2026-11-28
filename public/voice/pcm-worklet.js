// Accumulates mono input and posts 100 ms Float32 chunks to the main thread
// for 16 kHz PCM16 encoding. Loaded by lib/voice/mic.ts via AudioWorklet.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(4800);
    this._len = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this._buf[this._len++] = channel[i];
        if (this._len === this._buf.length) {
          this.port.postMessage(this._buf.slice(0));
          this._len = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
