// Voice-input client settings. Pi Web talks to a self-hosted OpenAI Realtime
// (speech-to-speech) server; everything here lives in localStorage so the
// feature needs no server-side configuration.

const ENABLED_KEY = "pi-voice-enabled";
const URL_KEY = "pi-voice-url";
const GATE_KEY = "pi-voice-gate";
const WAKE_KEY = "pi-voice-wake";
const EVENTS_KEY = "pi-voice-events";

interface ItemStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

function browserStorage(): ItemStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Defaults for this deployment: the home Tailnet TLS endpoint first, then the
 * LAN address. Override with a single URL in Settings → General → Voice input.
 * A one-line change when the fork points the feature somewhere else.
 */
export const DEFAULT_REALTIME_URLS = [
  "wss://desktop.quoll-stairs.ts.net:8765/v1/realtime",
  "ws://192.168.124.194:8765/v1/realtime",
];

export function getVoiceEnabled(storage: ItemStorage | null = browserStorage()): boolean {
  const raw = storage?.getItem(ENABLED_KEY);
  return raw === null || raw === undefined ? true : raw === "1";
}

export function setVoiceEnabled(on: boolean, storage: ItemStorage | null = browserStorage()): void {
  try {
    if (on) storage?.setItem(ENABLED_KEY, "1");
    else storage?.setItem(ENABLED_KEY, "0");
  } catch {
    // Private mode / storage disabled: the session keeps the current value.
  }
}

/** The configured override URL, or "" when the defaults are used. */
export function getRealtimeUrl(storage: ItemStorage | null = browserStorage()): string {
  return storage?.getItem(URL_KEY)?.trim() ?? "";
}

export function setRealtimeUrl(url: string, storage: ItemStorage | null = browserStorage()): void {
  try {
    const trimmed = url.trim();
    if (trimmed) storage?.setItem(URL_KEY, trimmed);
    else storage?.removeItem?.(URL_KEY);
  } catch {
    // Storage unavailable: nothing to persist.
  }
}

/**
 * Candidate WebSocket URLs in attempt order.
 *
 * A page served over `https:` never gets the plaintext candidate: browsers
 * block `ws://` from a secure page as mixed content, so the attempt cannot
 * work and it marks the whole tab "not secure" for that navigation. The LAN
 * address stays in the list for `http://` pages (a phone on the hotspot,
 * `npm run dev`). A single URL typed in Settings is honoured exactly as
 * written, and a deployment whose defaults are all plaintext still tries
 * them: an empty list would fail before anything reaches the wire.
 */
export function getRealtimeUrls(storage: ItemStorage | null = browserStorage()): string[] {
  const override = getRealtimeUrl(storage);
  if (override) return [override];
  const defaults = [...DEFAULT_REALTIME_URLS];
  if (typeof location === "undefined" || location.protocol !== "https:") return defaults;
  const secure = defaults.filter((url) => url.startsWith("wss://"));
  return secure.length > 0 ? secure : defaults;
}

/**
 * How hard the microphone is gated against the room: 0 uploads everything, 100
 * only speech at the mouth. The default cuts a voice through a wall, which a
 * phone's own gain control otherwise lifts to your level.
 */
export const DEFAULT_GATE_SENSITIVITY = 45;

export function getGateSensitivity(storage: ItemStorage | null = browserStorage()): number {
  const raw = storage?.getItem(GATE_KEY);
  if (raw === null || raw === undefined) return DEFAULT_GATE_SENSITIVITY;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : DEFAULT_GATE_SENSITIVITY;
}

export function setGateSensitivity(value: number, storage: ItemStorage | null = browserStorage()): void {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return;
  const clamped = Math.max(0, Math.min(100, Math.round(parsed)));
  try {
    if (clamped === DEFAULT_GATE_SENSITIVITY) storage?.removeItem?.(GATE_KEY);
    else storage?.setItem(GATE_KEY, String(clamped));
  } catch {
    // Storage unavailable: the session keeps the current value.
  }
}

/**
 * Whether the voice bridge waits for pi's own run-end event (the default, ADR 0008) or falls
 * back to polling the session's state and transcript. The switch exists so a wire mismatch or a
 * refused event stream is one setting away from the old behaviour, without a rebuild: the poll
 * answers late and by inference, but it still answers.
 */
export function getEventStreamEnabled(storage: ItemStorage | null = browserStorage()): boolean {
  return storage?.getItem(EVENTS_KEY) !== "0";
}

export function setEventStreamEnabled(on: boolean, storage: ItemStorage | null = browserStorage()): void {
  try {
    if (on) storage?.removeItem?.(EVENTS_KEY);
    else storage?.setItem(EVENTS_KEY, "0");
  } catch {
    // Storage unavailable: the session keeps the current value.
  }
}

/**
 * The address word a turn must contain to be answered. "" (the default) answers
 * anything addressed to the call, which is what a solo room wants; a name is what
 * a shared living room wants.
 */
export function getWakeWord(storage: ItemStorage | null = browserStorage()): string {
  return storage?.getItem(WAKE_KEY)?.trim() ?? "";
}

export function setWakeWord(word: string, storage: ItemStorage | null = browserStorage()): void {
  try {
    const trimmed = (word ?? "").trim();
    if (trimmed) storage?.setItem(WAKE_KEY, trimmed);
    else storage?.removeItem?.(WAKE_KEY);
  } catch {
    // Storage unavailable: nothing to persist.
  }
}
