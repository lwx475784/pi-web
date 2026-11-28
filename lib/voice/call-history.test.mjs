import assert from "node:assert/strict";
import test from "node:test";

import {
  appendCallTurn,
  buildReplayMessage,
  CALL_HISTORY_TTL_MS,
  callHistoryKey,
  clearCallHistory,
  loadCallHistory,
  MAX_REPLAY_CHARS,
  migrateCallHistory,
} from "./call-history.ts";

/** A localStorage stand-in: the same Map-shaped contract, no browser. */
function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? String(data.get(key)) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

const T0 = 1_800_000_000_000;

test("the transcript survives an append and reads back in order", () => {
  const store = memoryStore();
  appendCallTurn("s1", { who: "me", text: "查一下" }, store);
  appendCallTurn("s1", { who: "pi", text: "在 LaunchAgents" }, store);
  const turns = loadCallHistory("s1", store);
  assert.deepEqual(turns.map((t) => [t.who, t.text]), [["me", "查一下"], ["pi", "在 LaunchAgents"]]);
  assert.ok(turns.every((t) => typeof t.at === "number"));
});

test("blank turns are not recorded", () => {
  const store = memoryStore();
  appendCallTurn("s1", { who: "me", text: "   " }, store);
  assert.deepEqual(loadCallHistory("s1", store), []);
});

test("turns older than a day are dropped on read, and unstamped legacy rows are kept", () => {
  const key = callHistoryKey("s1");
  const store = memoryStore({
    [key]: JSON.stringify([
      { who: "me", text: "昨天的话", at: T0 - CALL_HISTORY_TTL_MS - 1000 },
      { who: "pi", text: "今天的话", at: T0 - 60_000 },
      { who: "me", text: "没时间戳的老记录" },
    ]),
  });
  const turns = loadCallHistory("s1", store, T0);
  assert.deepEqual(turns.map((t) => t.text), ["今天的话", "没时间戳的老记录"]);
});

test("clearCallHistory forgets the session and touches nobody else's", () => {
  const store = memoryStore();
  appendCallTurn("s1", { who: "me", text: "一" }, store);
  appendCallTurn("s2", { who: "me", text: "二" }, store);
  clearCallHistory("s1", store);
  assert.deepEqual(loadCallHistory("s1", store), []);
  assert.equal(loadCallHistory("s2", store).length, 1);
  clearCallHistory("", store);
});

test("migrateCallHistory moves a pre-session call onto the session that made it", () => {
  const store = memoryStore();
  appendCallTurn("new:abc:/tmp", { who: "me", text: "第一问" }, store);
  migrateCallHistory("new:abc:/tmp", "s9", store);
  assert.deepEqual(loadCallHistory("s9", store).map((t) => t.text), ["第一问"]);
  assert.deepEqual(loadCallHistory("new:abc:/tmp", store), []);
});

test("a corrupt record reads as no history", () => {
  const store = memoryStore({ [callHistoryKey("s1")]: "{not json" });
  assert.deepEqual(loadCallHistory("s1", store), []);
});

test("the replay digest is bounded in turns and in characters", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ who: "me", text: `第 ${i} 句`, at: T0 }) );
  const digest = buildReplayDigest(many);
  assert.ok(digest.split("\n").length - 1 <= 12, digest.split("\n").length);

  const huge = [
    { who: "pi", text: "短", at: T0 },
    { who: "pi", text: "长".repeat(MAX_REPLAY_CHARS), at: T0 },
  ];
  const capped = buildReplayDigest(huge);
  assert.ok(capped.length <= MAX_REPLAY_CHARS + 100, capped.length);
  assert.ok(capped.includes("短"), "whole turns only: the oldest kept line still stands alone");
  assert.ok(!capped.includes("长长"), "a turn that cannot fit is dropped, not sliced mid-word");

  assert.equal(buildReplayDigest([]), "");
});

/** buildReplayMessage takes the turns the loader would return; the clock does not matter here. */
function buildReplayDigest(turns) {
  return buildReplayMessage(turns);
}
