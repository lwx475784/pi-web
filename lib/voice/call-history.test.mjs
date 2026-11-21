import assert from "node:assert/strict";
import test from "node:test";

import { appendCallTurn, buildReplayMessage, callHistoryKey, loadCallHistory } from "./call-history.ts";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    set: (k, v) => { store.set(k, v); },
  };
}

test("missing or corrupt history loads as empty", () => {
  const s = memoryStorage();
  assert.deepEqual(loadCallHistory("x", s), []);
  s.set(callHistoryKey("x"), "not json");
  assert.deepEqual(loadCallHistory("x", s), []);
  s.set(callHistoryKey("x"), JSON.stringify([{ who: "me", text: 3 }, { who: "ai", text: "好" }]));
  assert.deepEqual(loadCallHistory("x", s).map((t) => t.text), ["好"]);
});

test("appends persist, trim at the cap and blank text is a no-op", () => {
  const s = memoryStorage();
  for (let i = 0; i < 45; i++) appendCallTurn("x", { who: "me", text: `句${i}` }, s);
  const loaded = loadCallHistory("x", s);
  assert.equal(loaded.length, 40);
  assert.equal(loaded.at(-1).text, "句44");
  assert.equal(loaded[0].text, "句5");
  const before = loaded.length;
  appendCallTurn("x", { who: "me", text: "   " }, s);
  assert.equal(loadCallHistory("x", s).length, before);
});

test("replay digest is bounded, labelled, and empty for no history", () => {
  assert.equal(buildReplayMessage([]), "");
  const turns = Array.from({ length: 20 }, (_, i) => ({ who: "me", text: `问${i}`, at: i }));
  const digest = buildReplayMessage(turns);
  assert.ok(digest.startsWith("[之前"));
  const lines = digest.split("\n");
  assert.equal(lines.length, 1 + 12); // only the recent window rides the context
  assert.ok(lines[1].startsWith("我: 问8"));
});
