import assert from "node:assert/strict";
import test from "node:test";

import { createRunEndWatcher } from "./answer-watcher.ts";

/** A stand-in EventSource: the test decides what arrives, and when. */
function fakeSource({ silent = false } = {}) {
  const seen = [];
  const source = {
    onmessage: null,
    onerror: null,
    closed: 0,
    close() { source.closed += 1; },
    emit(event) { source.onmessage?.({ data: JSON.stringify(event) }); },
  };
  seen.push(source);
  const createSource = () => (silent ? { onmessage: null, onerror: null, close() {} } : source);
  return { source, createSource, opened: seen };
}

test("the wait resolves when pi announces the end of the run our request started", async () => {
  const { source, createSource } = fakeSource();
  const watcher = createRunEndWatcher({ createSource });
  const pending = watcher.whenRunEnds("s1", "r-1", 5000);
  source.emit({ type: "user_message_entry", entryId: "u-9", requestId: "r-1" });
  source.emit({ type: "prompt_done", requestId: "r-1" });
  assert.deepEqual(await pending, { ended: true, anchorEntryId: "u-9" });
  assert.equal(source.closed, 1, "the stream is let go as soon as the last wait settles");
});

test("another client's run end is not ours, and a stop is reported as aborted", async () => {
  const { source, createSource } = fakeSource();
  const watcher = createRunEndWatcher({ createSource });
  const pending = watcher.whenRunEnds("s1", "r-1", 5000);
  source.emit({ type: "prompt_done", requestId: "other" });
  source.emit({ type: "heartbeat" });
  source.emit({ type: "prompt_error", requestId: "nope" });
  source.emit({ type: "prompt_done", requestId: "r-1", aborted: true });
  assert.deepEqual(await pending, { ended: true, aborted: true });
});

test("a prompt_error also ends the wait: the answer may be an error line, but the run is over", async () => {
  const { source, createSource } = fakeSource();
  const watcher = createRunEndWatcher({ createSource });
  const pending = watcher.whenRunEnds("s1", "r-1", 5000);
  source.emit({ type: "prompt_error", requestId: "r-1", errorMessage: "upstream 500" });
  assert.deepEqual(await pending, { ended: true });
});

test("a stream that never delivers is written off, so the caller polls instead of waiting", async () => {
  const { createSource } = fakeSource({ silent: true });
  const watcher = createRunEndWatcher({ createSource, streamDeadMs: 5 });
  assert.deepEqual(await watcher.whenRunEnds("s1", "r-1", 5000), { ended: false });
});

test("a wait that outlives the answer gives up with false, never an error", async () => {
  const { source, createSource } = fakeSource();
  const watcher = createRunEndWatcher({ createSource, streamDeadMs: 10_000 });
  const pending = watcher.whenRunEnds("s1", "r-1", 5);
  source.emit({ type: "heartbeat" });
  assert.deepEqual(await pending, { ended: false });
});

test("close() abandons every pending wait so a hang-up cannot leave a promise hanging", async () => {
  const sources = [];
  const watcher = createRunEndWatcher({
    createSource: () => { const fake = fakeSource(); sources.push(fake.source); return fake.source; },
    streamDeadMs: 10_000,
  });
  const first = watcher.whenRunEnds("s1", "r-1", 10_000);
  const second = watcher.whenRunEnds("s2", "r-2", 10_000);
  watcher.close();
  assert.deepEqual(await first, { ended: false });
  assert.deepEqual(await second, { ended: false });
  assert.deepEqual(sources.map((s) => s.closed), [1, 1], "one stream per session, both let go");
});

test("waits on different sessions keep their own streams, and each closes when done", async () => {
  const created = [];
  const watcher = createRunEndWatcher({
    createSource: (url) => {
      const fake = fakeSource();
      created.push({ url, ...fake });
      return fake.source;
    },
  });
  const a = watcher.whenRunEnds("s1", "r-1", 5000);
  const b = watcher.whenRunEnds("s2", "r-2", 5000);
  assert.match(created[0].url, /^\/api\/agent\/s1\/events$/);
  assert.match(created[1].url, /^\/api\/agent\/s2\/events$/);
  created[0].source.emit({ type: "prompt_done", requestId: "r-1" });
  created[1].source.emit({ type: "prompt_done", requestId: "r-2" });
  assert.deepEqual(await a, { ended: true });
  assert.deepEqual(await b, { ended: true });
  assert.equal(created[0].source.closed, 1);
  assert.equal(created[1].source.closed, 1);
});
