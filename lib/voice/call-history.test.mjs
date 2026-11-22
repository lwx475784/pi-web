import assert from "node:assert/strict";
import test from "node:test";

import { appendCallTurn, buildReplayMessage, callHistoryKey, loadCallHistory, migrateCallHistory } from "./call-history.ts";

function memoryStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
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

test("a call moves onto the session its first question to pi created", () => {
  const s = memoryStorage();
  appendCallTurn("new:draft:/tmp", { who: "me", text: "你好" }, s);
  appendCallTurn("new:draft:/tmp", { who: "ai", text: "在的" }, s);
  migrateCallHistory("new:draft:/tmp", "s1", s);
  assert.deepEqual(loadCallHistory("s1", s).map((t) => t.text), ["你好", "在的"]);
  assert.deepEqual(loadCallHistory("new:draft:/tmp", s), []);
  assert.equal(s.getItem(callHistoryKey("new:draft:/tmp")), null);
  // A later turn lands on the session, and the whole scene replays in order.
  appendCallTurn("s1", { who: "pi", text: "找到了" }, s);
  assert.deepEqual(buildReplayMessage(loadCallHistory("s1", s)).split("\n").slice(1), ["我: 你好", "助手: 在的", "pi: 找到了"]);
});

test("migrating merges after what the session already holds and never repeats", () => {
  const s = memoryStorage();
  appendCallTurn("draft", { who: "me", text: "旧问" }, s);
  appendCallTurn("s1", { who: "me", text: "已有" }, s);
  migrateCallHistory("draft", "s1", s);
  migrateCallHistory("draft", "s1", s); // the second time there is nothing to move
  assert.deepEqual(loadCallHistory("s1", s).map((t) => t.text), ["已有", "旧问"]);
  // Same key, and an empty source: no-ops that keep the history where it is.
  migrateCallHistory("s1", "s1", s);
  migrateCallHistory("nothing", "s1", s);
  assert.deepEqual(loadCallHistory("s1", s).map((t) => t.text), ["已有", "旧问"]);
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
