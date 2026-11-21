// Microphone capture: getUserMedia -> AudioWorklet -> 16 kHz mono PCM16 base64.
//
// The Realtime server resamples anyway; 16 kHz keeps the WebSocket light and
// matches what every OpenAI Realtime client sends.

const TARGET_RATE = 16000;
const WORKLET_URL = "/voice/pcm-worklet.js";

/** Linear-interpolating resampler; good enough for ASR input. */
export function resampleToRate(input: Float32Array, inputRate: number, targetRate = TARGET_RATE): Float32Array {
  if (inputRate === targetRate || input.length === 0) return input;
  const ratio = targetRate / inputRate;
  const outLength = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const src = i / ratio;
    const lower = Math.floor(src);
    const upper = Math.min(input.length - 1, lower + 1);
    const frac = src - lower;
    out[i] = input[lower] * (1 - frac) + input[upper] * frac;
  }
  return out;
}

export function floatToInt16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(clamped * 0x7fff), true);
  }
  if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export interface MicHandle {
  stop(): Promise<void>;
}

/**
 * Start capture; `onChunk` receives ~100 ms base64 PCM16 16 kHz frames. The
 * caller must invoke this from a user gesture (iOS Safari requirement).
 */
export async function startMicCapture(onChunk: (base64Pcm16: string) => void): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // SAFETY: older WebKit exposes the same Web Audio surface as webkitAudioContext.
  const AudioCtor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("Web Audio is unavailable");
  }
  const ctx = new AudioCtor();
  try {
    await ctx.resume();
    const workletResponse = await fetch(WORKLET_URL);
    const moduleSource = await workletResponse.text();
    // A blob URL, not data:: Safari's AudioWorklet refuses data: module specs.
    const moduleUrl = URL.createObjectURL(new Blob([moduleSource], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await ctx.close().catch(() => undefined);
    throw error;
  }
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const resampled = resampleToRate(event.data, ctx.sampleRate);
    onChunk(floatToInt16Base64(resampled));
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      node.port.onmessage = null;
      try { source.disconnect(); node.disconnect(); mute.disconnect(); } catch { /* already gone */ }
      stream.getTracks().forEach((track) => track.stop());
      await ctx.close().catch(() => undefined);
    },
  };
}
