import assert from "node:assert/strict";
import test from "node:test";

import { askPiReply, contextEntries, createRequestId, isPiRequestCancelled, lastAssistantText, PiRequestCancelled, readPiQueueCount, stopPiRun } from "./pi-bridge.ts";

test("lastAssistantText reads plain and wrapped entries, newest first", () => {
  assert.equal(lastAssistantText([
    { role: "user", content: "问" },
    { role: "assistant", content: [{ type: "text", text: "旧答" }] },
    { role: "assistant", content: [{ type: "text", text: "新答" }, { type: "tool_use" }] },
  ]), "新答");
  assert.equal(lastAssistantText([
    { type: "message", message: { role: "assistant", content: "包一层的" } },
  ]), "包一层的");
  assert.equal(lastAssistantText([{ role: "user", content: "只有用户" }]), "");
  assert.equal(lastAssistantText("不是数组"), "");
});

test("contextEntries reads the route's paged shape, a bare list, and nothing else", () => {
  assert.equal(contextEntries({ messages: [{ role: "user" }, { role: "assistant", content: "答" }], entryIds: ["e0", "e1"] }).length, 2);
  assert.equal(lastAssistantText({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "分页里的答" }] }] }), "分页里的答");
  assert.equal(contextEntries([{ role: "user" }]).length, 1);
  assert.deepEqual(contextEntries(undefined), []);
  assert.deepEqual(contextEntries("nope"), []);
  assert.deepEqual(contextEntries({ messages: "nope" }), []);
});

function fakeWorld({ rejectSend = false, busyThenQueue = false, turnsUntilIdle = 2, paged = true } = {}) {
  const state = { leaf: "leaf-1", running: turnsUntilIdle, sent: null, posts: 0, aborts: 0, bodies: [] };
  const json = (obj) => ({ ok: true, json: async () => obj });
  const fetchImpl = async (url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body);
      if (body.type === "abort") { state.aborts += 1; return json({ success: true, data: null }); }
      state.posts += 1;
      state.bodies.push(body);
      state.sent = body.message;
      if (rejectSend) return { ok: false, status: 500, json: async () => ({ error: "boom", code: "prompt_rejected" }) };
      // pi mid-run refuses a bare prompt and accepts it as a queued follow-up.
      if (busyThenQueue && body.streamingBehavior !== "followUp") {
        return json({
          error: "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          code: "prompt_rejected", accepted: false,
        });
      }
      return json({ success: true, data: {} });
    }
    if (url.includes("/api/agent/")) {
      state.running = Math.max(0, state.running - 1);
      // The wrapper is alive the whole time; only the run inside it says whether an
      // answer is ready. A status page without `state` never exercised the gate.
      return json({ running: true, state: { isStreaming: state.running > 0 } });
    }
    // Context reads: the leaf only moves once the answer exists, and the answer
    // rides the paged shape the route really answers with.
    const fresh = state.running === 0;
    const messages = fresh
      ? [{ role: "user", content: [{ type: "text", text: state.sent }] }, { role: "assistant", content: [{ type: "thinking", thinking: "想了一下" }, { type: "text", text: "pi 的回答" }] }]
      : [{ role: "user", content: "旧" }, { role: "assistant", content: "旧的答" }];
    return json({
      leafId: fresh ? "leaf-2" : state.leaf,
      context: paged ? { messages, entryIds: messages.map((_, i) => `e${i}`), hasMore: false } : messages,
    });
  };
  return { state, fetchImpl };
}

const RID = { type: "prompt", message: "帮我看看天气", requestId: "r-1" };

test("askPiReply posts the prompt and returns the first new assistant answer", async () => {
  const { state, fetchImpl } = fakeWorld();
  const answer = await askPiReply("s1", "帮我看看天气", { fetchImpl, pollMs: 1, requestIdFactory: () => "r-1" });
  assert.equal(answer, "pi 的回答");
  assert.equal(state.sent, "帮我看看天气");
  assert.ok(state.posts === 1);
  assert.deepEqual(state.bodies[0], RID);
});

test("createRequestId mints bounded opaque ids, unique enough to pair a question with its answer", () => {
  const ids = new Set(Array.from({ length: 50 }, createRequestId));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
});

test("an ask the user agreed to queue joins the running turn and reports it has no identity", async () => {
  const { state, fetchImpl } = fakeWorld();
  const seen = [];
  assert.equal(await askPiReply("s1", "排队的问题", {
    fetchImpl, pollMs: 1, queueBehind: true, requestIdFactory: () => "r-7",
    onDisposition: (d) => seen.push(d),
  }), "pi 的回答");
  assert.deepEqual(state.bodies, [{ type: "prompt", message: "排队的问题", requestId: "r-7", streamingBehavior: "followUp" }]);
  assert.deepEqual(seen, [{ joinedAnotherRun: true }]);
  assert.equal(state.posts, 1, "no wasted first attempt");
});

test("a plain ask that starts a run reports the identity the event handshake needs", async () => {
  const { fetchImpl } = fakeWorld();
  const seen = [];
  await askPiReply("s1", "直接问", { fetchImpl, pollMs: 1, onDisposition: (d) => seen.push(d) });
  assert.deepEqual(seen, [{ joinedAnotherRun: false }]);
});

test("a rejected prompt surfaces as a busy error", async () => {
  const { fetchImpl } = fakeWorld({ rejectSend: true });
  await assert.rejects(() => askPiReply("s1", "x", { fetchImpl, pollMs: 1 }), /pi is busy/);
});

test("a prompt that lands mid-run is re-sent as a queued follow-up", async () => {
  const { state, fetchImpl } = fakeWorld({ busyThenQueue: true });
  assert.equal(await askPiReply("s1", "第二个问题", { fetchImpl, pollMs: 1, requestIdFactory: () => "r-2" }), "pi 的回答");
  assert.deepEqual(state.bodies, [
    { type: "prompt", message: "第二个问题", requestId: "r-2" },
    { type: "prompt", message: "第二个问题", requestId: "r-2", streamingBehavior: "followUp" },
  ]);
});

test("a queued follow-up has no run identity, so the event wait is skipped and the poll answers", async () => {
  const { state, fetchImpl } = fakeWorld({ busyThenQueue: true });
  let asked = 0;
  const watcher = { whenRunEnds: async () => { asked += 1; return { ended: false }; }, close() {} };
  const answer = await askPiReply("s1", "排队的问题", { fetchImpl, pollMs: 1, watcher, requestIdFactory: () => "r-3" });
  assert.equal(answer, "pi 的回答");
  assert.equal(asked, 0, "a submission that joined somebody else's run cannot be awaited by name");
  assert.ok(state.posts === 2);
});

test("the run-end event names our request, so the answer is read once without polling state", async () => {
  const { state, fetchImpl } = fakeWorld({ turnsUntilIdle: 1 });
  let statusReads = 0;
  const counting = async (url, init) => {
    if (!init?.method && url.includes("/api/agent/")) statusReads += 1;
    return fetchImpl(url, init);
  };
  const watcher = {
    whenRunEnds: async (sid, rid) => {
      assert.equal(sid, "s1");
      assert.equal(rid, "r-4");
      // The run ending is what makes the answer appear; the bridge must not poll to learn that.
      state.running = 0;
      return { ended: true, anchorEntryId: "u-1" };
    },
    close() {},
  };
  assert.equal(await askPiReply("s1", "帮我看看天气", { fetchImpl: counting, pollMs: 1, watcher, requestIdFactory: () => "r-4" }), "pi 的回答");
  assert.equal(statusReads, 0, "the event replaced the status poll entirely");
  assert.equal(state.posts, 1);
});

test("an event that says the run ended without any new text falls back to polling", async () => {
  const { fetchImpl } = fakeWorld();
  const watcher = { whenRunEnds: async () => ({ ended: true }), close() {} };
  assert.equal(await askPiReply("s1", "x", { fetchImpl, pollMs: 1, watcher, requestIdFactory: () => "r-5" }), "pi 的回答");
});

test("a watcher that learns nothing still delivers the answer by polling", async () => {
  const { fetchImpl } = fakeWorld();
  const watcher = { whenRunEnds: async () => ({ ended: false }), close() {} };
  assert.equal(await askPiReply("s1", "x", { fetchImpl, pollMs: 1, watcher, requestIdFactory: () => "r-6" }), "pi 的回答");
});

test("a run longer than the old three-minute cap still gets announced", async () => {
  // 400 idle polls at 1 ms: the answer is late, not lost.
  const { fetchImpl } = fakeWorld({ turnsUntilIdle: 400 });
  assert.equal(await askPiReply("s1", "慢活", { fetchImpl, pollMs: 1 }), "pi 的回答");
});

test("askPiReply also reads a context page sent as a bare entry list", async () => {
  const { fetchImpl } = fakeWorld({ paged: false });
  assert.equal(await askPiReply("s1", "帮我看看天气", { fetchImpl, pollMs: 1 }), "pi 的回答");
});

test("cancelling the wait stops polling and reads as a cancellation", async () => {
  const { state, fetchImpl } = fakeWorld({ turnsUntilIdle: 99 });
  const controller = new AbortController();
  const pending = askPiReply("s1", "查一下", { fetchImpl, pollMs: 5, signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  const error = await pending.then(() => null, (e) => e);
  assert.ok(error instanceof PiRequestCancelled);
  assert.ok(isPiRequestCancelled(error));
  assert.ok(isPiRequestCancelled(new DOMException(" aborted", "AbortError")));
  assert.ok(!isPiRequestCancelled(new Error("timeout")));
  // pi keeps running; only the wait ended. The prompt went out once.
  assert.equal(state.posts, 1);
});

test("readPiQueueCount counts what the keyboard has queued", async () => {
  const full = await readPiQueueCount("s1", { fetchImpl: async () => ({
    ok: true,
    json: async () => ({ running: true, state: { queuedMessages: { steering: ["a", "b"], followUp: ["c"] } } }),
  }) });
  assert.equal(full, 3);

  const bare = await readPiQueueCount("s1", { fetchImpl: async () => ({ ok: true, json: async () => ({ running: true, state: {} }) }) });
  assert.equal(bare, 0);
  const offline = await readPiQueueCount("s1", { fetchImpl: async () => { throw new TypeError("offline"); } });
  assert.equal(offline, 0);
});

test("stopPiRun posts pi's abort command to its own session", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ success: true, data: null }) };
  };
  await stopPiRun("s/1", { fetchImpl });
  assert.deepEqual(seen, [{ url: "/api/agent/s%2F1", body: { type: "abort" } }]);
});

test("stopPiRun stays quiet when pi was already idle", async () => {
  const fetchImpl = async () => { throw new TypeError("offline"); };
  await stopPiRun("s1", { fetchImpl });
});
