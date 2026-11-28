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

/** Fake the page origin for one call: settings.ts reads `location` when asked. */
function withPageProtocol(protocol, run) {
  const had = "location" in globalThis;
  const previous = globalThis.location;
  Object.defineProperty(globalThis, "location", { value: { protocol }, configurable: true, writable: true });
  try {
    return run();
  } finally {
    if (had) Object.defineProperty(globalThis, "location", { value: previous, configurable: true, writable: true });
    else delete globalThis.location;
  }
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

test("an https page offers no plaintext candidate: ws:// is mixed content", () => {
  const storage = memoryStorage();
  withPageProtocol("https:", () => {
    const urls = getRealtimeUrls(storage);
    assert.deepEqual(urls, DEFAULT_REALTIME_URLS.filter((url) => url.startsWith("wss://")));
    assert.ok(urls.length > 0, "a secure page must still have somewhere to dial");
    assert.ok(!urls.some((url) => url.startsWith("ws://")), "no ws:// candidate from a secure page");
  });
});

test("an http page keeps the LAN address, and an explicit ws:// override is honoured", () => {
  const storage = memoryStorage();
  withPageProtocol("http:", () => {
    assert.deepEqual(getRealtimeUrls(storage), DEFAULT_REALTIME_URLS);
  });
  setRealtimeUrl("ws://192.168.124.194:8765/v1/realtime", storage);
  withPageProtocol("https:", () => {
    assert.deepEqual(getRealtimeUrls(storage), ["ws://192.168.124.194:8765/v1/realtime"]);
  });
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
