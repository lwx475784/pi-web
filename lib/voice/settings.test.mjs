import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_GATE_SENSITIVITY, DEFAULT_REALTIME_URLS, getGateSensitivity, getRealtimeUrl, getRealtimeUrls, getVoiceEnabled, getWakeWord, setGateSensitivity, setRealtimeUrl, setVoiceEnabled, setWakeWord } from "./settings.ts";

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

test("the voice gate defaults, clamps, and stores nothing at the default", () => {
  const storage = memoryStorage();
  assert.equal(getGateSensitivity(storage), DEFAULT_GATE_SENSITIVITY);
  setGateSensitivity(80, storage);
  assert.equal(getGateSensitivity(storage), 80);
  setGateSensitivity(140, storage);
  assert.equal(getGateSensitivity(storage), 100);
  setGateSensitivity(-5, storage);
  assert.equal(getGateSensitivity(storage), 0);
  setGateSensitivity("nonsense", storage);
  assert.equal(getGateSensitivity(storage), 0);
  // Back to the default: no key left behind, so a changed default still applies.
  setGateSensitivity(DEFAULT_GATE_SENSITIVITY, storage);
  assert.equal(getGateSensitivity(storage), DEFAULT_GATE_SENSITIVITY);
});

test("a stored gate value outside the range falls back to the default", () => {
  const storage = memoryStorage();
  storage.setItem("pi-voice-gate", "700");
  assert.equal(getGateSensitivity(storage), DEFAULT_GATE_SENSITIVITY);
});

test("an empty wake word answers anything, a stored one gates the turn", () => {
  const storage = memoryStorage();
  assert.equal(getWakeWord(storage), "");
  setWakeWord("  静静 ", storage);
  assert.equal(getWakeWord(storage), "静静");
  setWakeWord("", storage);
  assert.equal(getWakeWord(storage), "");
});

test("a missing storage falls back to defaults without throwing", () => {
  assert.equal(getVoiceEnabled(null), true);
  assert.deepEqual(getRealtimeUrls(null), DEFAULT_REALTIME_URLS);
  setVoiceEnabled(false, null);
  setRealtimeUrl("wss://x/v1", null);
  assert.equal(getGateSensitivity(null), DEFAULT_GATE_SENSITIVITY);
  setGateSensitivity(30, null);
  setWakeWord("静静", null);
  assert.equal(getWakeWord(null), "");
});
