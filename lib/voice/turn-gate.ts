// Two gates that keep a shared house out of a voice call.
//
// The realtime server answers any speech its VAD hears, so a voice from the next
// room becomes a turn — and a phone's automatic gain control lifts it to about
// your level, which is why a near-talk microphone does not solve it alone. The
// capture gate drops those frames to silence before they are uploaded; the
// transcript gate rejects what the recogniser still makes out of them: one
// interjection, a stray foreign word, or talk that was never aimed at the
// assistant.

/** 0 keeps everything, 100 keeps only speech right at the mouth. */
export type GateSensitivity = number;

export interface SilenceFill {
  /** A base64 PCM16 frame of zeros, the same byte length as `frameB64`. */
  (frameB64: string): string;
}

export interface NearGateOptions {
  sensitivity: GateSensitivity;
  /** Frames of level drop tolerated before the gate closes (word endings). */
  holdFrames?: number;
  /** Frames kept and released on opening, so the onset of a word is not cut. */
  prerollFrames?: number;
  /** Never open below this dBFS: a silent room must not let a cough start a turn. */
  minOpenDbfs?: number;
}

export interface NearGateHandle {
  readonly open: boolean;
  /**
   * One capture frame (~100 ms) of linear samples plus its PCM16 base64 form.
   * Returns the frames to upload: the frame itself while open, a same-length
   * silence otherwise, so the server's VAD still measures real gaps and ends its
   * turn.
   */
  push(samples: Float32Array, frameB64: string): string[];
}

const FLOOR_FALL_RATE = 0.5;   // the room floor drops fast when it gets quieter
const FLOOR_RISE_RATE = 0.01;  // and climbs slowly, so your own speech never raises it
const PEAK_DECAY_DB_PER_FRAME = 0.1; // 1 dB/s: the loudest recent speech keeps setting the bar

/**
 * A loudness gate for a shared house. A frame counts as the user's speech when
 * it is both well over the room floor and close to the loudest speech this call
 * has recently heard: talk through a wall or from the next room sits 15-25 dB
 * under near-talk, and no "is this my voice" model is needed to use that gap.
 * Neither bar can tell a lone distant voice from a quiet you — that is what the
 * address word in Settings is for.
 */
export function createNearSpeechGate(opts: NearGateOptions): NearGateHandle {
  const holdFrames = opts.holdFrames ?? 4;         // 400 ms
  const prerollFrames = opts.prerollFrames ?? 2;   // 200 ms
  const minOpenDbfs = opts.minOpenDbfs ?? -50;
  const sensitivity = Math.max(0, Math.min(100, opts.sensitivity));
  const overFloor = 6 + sensitivity * 0.2;      // 0 → 6 dB over the floor, 100 → 26
  const underPeak = 22 - sensitivity * 0.16;    // 0 → 22 dB under the peak, 100 → 6

  const silence = createSilenceFill();
  const preroll: string[] = [];
  let floorDb = -70;
  let peakDb = -120;
  let thresholdDb = minOpenDbfs;
  let isOpen = false;
  let quietFrames = 0;

  return {
    get open() { return isOpen },
    push(samples: Float32Array, frameB64: string): string[] {
      if (!frameB64) return [];
      const levelDb = frameLevelDb(samples);
      if (levelDb < floorDb) floorDb += FLOOR_FALL_RATE * (levelDb - floorDb);
      else floorDb += FLOOR_RISE_RATE * (levelDb - floorDb);
      if (levelDb < thresholdDb) peakDb = Math.max(levelDb, peakDb - PEAK_DECAY_DB_PER_FRAME);
      else peakDb = levelDb;   // only speech-looking frames move the reference
      thresholdDb = Math.max(floorDb + overFloor, peakDb - underPeak, minOpenDbfs);

      if (!isOpen) {
        if (levelDb < thresholdDb) {
          preroll.push(frameB64);
          while (preroll.length > prerollFrames) preroll.shift();
          return [silence(frameB64)];
        }
        isOpen = true;
        quietFrames = 0;
        const onset = preroll.splice(0, preroll.length);
        return [...onset, frameB64];
      }
      if (levelDb >= thresholdDb - 3) quietFrames = 0;
      else quietFrames += 1;
      if (quietFrames > holdFrames) {
        isOpen = false;
        preroll.length = 0;
        return [silence(frameB64)];
      }
      return [frameB64];
    },
  };
}

/** Root-mean-square of a Float32 frame, in dBFS (-120 for digital silence). */
export function frameLevelDb(samples: Float32Array): number {
  if (!samples.length) return -120;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return -120;
  return Math.max(-120, 20 * Math.log10(rms));
}

function createSilenceFill(): SilenceFill {
  const byLength = new Map<number, string>();
  return (frameB64: string) => {
    const bytes = base64ByteLength(frameB64);
    let zeros = byLength.get(bytes);
    if (zeros === undefined) {
      zeros = toBase64(new Uint8Array(bytes));
      byLength.set(bytes, zeros);
    }
    return zeros;
  };
}

/** Decoded length of a base64 string, counting its padding. */
function base64ByteLength(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// --- the transcript gate ---------------------------------------------------

export type TurnReject = "short" | "noise" | "address";

export interface TurnVerdict {
  accept: boolean;
  reason?: TurnReject;
}

export interface TurnGateOptions {
  /** When set, only turns containing it are answered (an address word). */
  wakeWord?: string;
}

// What the recogniser hallucinates out of murmur, and what a household member
// says to someone else: never an instruction on its own.
const INTERJECTIONS = new Set([
  "嗯", "哦", "啊", "呃", "唔", "噢", "哎", "诶", "呐", "哈", "嘿", "呀", "吧", "吗", "呢",
  "em", "en", "um", "uh", "hmm", "hm", "aha", "ha", "he", "oh", "yo", "hi",
]);

/** Letters only: punctuation and spacing carry no meaning for these rules. */
function speechLetters(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Decide whether one recognized utterance is worth an answer. `seconds` is the
 * turn's audio length when the server reports it; 0 skips the duration rule.
 */
export function classifyTurn(text: string, seconds = 0, opts: TurnGateOptions = {}): TurnVerdict {
  const letters = speechLetters(text ?? "");
  if (!letters) return { accept: false, reason: "noise" };
  if (seconds > 0 && seconds < 0.4) return { accept: false, reason: "short" };
  const lowered = letters.toLowerCase();
  const cjk = /[\u3400-\u9fff]/.test(lowered);
  if (INTERJECTIONS.has(lowered)) return { accept: false, reason: "noise" };
  if (!cjk) {
    // A lone short latin word is what distant speech turns into ("oder", "yo").
    if (letters.length <= 4 && !/\s/.test((text ?? "").trim())) return { accept: false, reason: "noise" };
  } else if (letters.length < 2) {
    return { accept: false, reason: "short" };
  }
  const wake = (opts.wakeWord ?? "").trim();
  if (wake && !containsAddress(text ?? "", wake)) return { accept: false, reason: "address" };
  return { accept: true };
}

/** Loose match for an address word: 静静 / 静静。， / Jingjing, ignoring spacing and case. */
export function containsAddress(text: string, wakeWord: string): boolean {
  const hay = speechLetters(text).toLowerCase();
  const needle = speechLetters(wakeWord).toLowerCase();
  return needle.length > 0 && hay.includes(needle);
}
