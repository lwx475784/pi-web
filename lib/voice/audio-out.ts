// Streaming PCM16 playback for realtime assistant audio. Chunks arrive as
// base64 on `response.output_audio.delta`; each becomes an AudioBufferSourceNode
// scheduled back-to-back so playback is gapless, and flush() stops everything
// the moment the user barges in.

const DEFAULT_RATE = 16000; // the speech-to-speech pipeline's wire format

export interface AudioOutHandle {
  enqueue(base64Pcm16: string): void;
  flush(): void;
  close(): void;
}

function base64ToInt16(b64: string): Int16Array {
  const bin = typeof atob === "function"
    ? atob(b64)
    : Buffer.from(b64, "base64").toString("binary");
  const out = new Int16Array(bin.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
  return out;
}

export function createAudioOut(sampleRate = DEFAULT_RATE): AudioOutHandle {
  const ctx = new AudioContext();
  void ctx.resume().catch(() => undefined);
  let nextTime = 0;
  let live: AudioBufferSourceNode[] = [];

  return {
    enqueue(b64: string) {
      try {
        if (!b64) return;
        const pcm = base64ToInt16(b64);
        if (!pcm.length) return;
        const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
        buffer.copyToChannel(Float32Array.from(pcm, (v) => v / 0x8000), 0);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        const startAt = Math.max(ctx.currentTime + 0.02, nextTime);
        source.start(startAt);
        nextTime = startAt + buffer.duration;
        const tracked = source;
        live.push(tracked);
        source.onended = () => {
          live = live.filter((s) => s !== tracked);
          try { source.disconnect(); } catch { /* done */ }
        };
      } catch {
        // A dead context or a truncated chunk must not kill the call.
      }
    },
    flush() {
      for (const source of live) {
        try { source.stop(); } catch { /* already ended */ }
      }
      live = [];
      nextTime = 0;
    },
    close() {
      this.flush();
      void ctx.close().catch(() => undefined);
    },
  };
}
