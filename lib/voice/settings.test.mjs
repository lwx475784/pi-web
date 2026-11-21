import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_REALTIME_URLS, getRealtimeUrl, getRealtimeUrls, getVoiceEnabled, setRealtimeUrl, setVoiceEnabled } from "./settings.ts";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
}

test("voice input is on until switched off", () => {
  const storage = memoryStorage();
  assert.equal(getVoiceEnabled(storage), true);
  setVoiceEnabled(false, storage);
  assert.equal(getVoiceEnabled(storage), false);
  setVoiceEnabled(true, storage);
  assert.equal(getVoiceEnabled(storage), true);
});

test("no stored url means the deployment defaults, in order", () => {
  const storage = memoryStorage();
  assert.deepEqual(getRealtimeUrls(storage), DEFAULT_REALTIME_URLS);
  assert.equal(getRealtimeUrl(storage), "");
});

test("a stored url overrides the defaults and blanks clear it", () => {
  const storage = memoryStorage();
  setRealtimeUrl("wss://example.test:9/v1/realtime", storage);
  assert.deepEqual(getRealtimeUrls(storage), ["wss://example.test:9/v1/realtime"]);
  setRealtimeUrl("  ", storage);
  assert.deepEqual(getRealtimeUrls(storage), DEFAULT_REALTIME_URLS);
});

test("a missing storage falls back to defaults without throwing", () => {
  assert.equal(getVoiceEnabled(null), true);
  assert.deepEqual(getRealtimeUrls(null), DEFAULT_REALTIME_URLS);
  setVoiceEnabled(false, null);
  setRealtimeUrl("wss://x/v1", null);
});
