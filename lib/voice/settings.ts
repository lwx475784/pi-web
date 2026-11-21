// Voice-input client settings. Pi Web talks to a self-hosted OpenAI Realtime
// (speech-to-speech) server; everything here lives in localStorage so the
// feature needs no server-side configuration.

const ENABLED_KEY = "pi-voice-enabled";
const URL_KEY = "pi-voice-url";

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

/** Candidate WebSocket URLs in attempt order. */
export function getRealtimeUrls(storage: ItemStorage | null = browserStorage()): string[] {
  const override = getRealtimeUrl(storage);
  return override ? [override] : [...DEFAULT_REALTIME_URLS];
}
