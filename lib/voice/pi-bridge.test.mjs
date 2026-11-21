import assert from "node:assert/strict";
import test from "node:test";

import { askPiReply, lastAssistantText } from "./pi-bridge.ts";

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

function fakeWorld({ rejectSend = false, turnsUntilIdle = 2 } = {}) {
  const state = { leaf: "leaf-1", running: turnsUntilIdle, sent: null, posts: 0 };
  const json = (obj) => ({ ok: true, json: async () => obj });
  const fetchImpl = async (url, init) => {
    if (init?.method === "POST") {
      state.posts += 1;
      state.sent = JSON.parse(init.body).message;
      if (rejectSend) return { ok: false, status: 500, json: async () => ({ error: "boom", code: "prompt_rejected" }) };
      return json({ success: true, data: {} });
    }
    if (url.includes("/api/agent/")) {
      state.running = Math.max(0, state.running - 1);
      return json({ running: state.running > 0 });
    }
    // Context reads: the leaf only moves once the answer exists.
    const fresh = state.running === 0;
    return json({
      leafId: fresh ? "leaf-2" : state.leaf,
      context: fresh
        ? [{ role: "user", content: state.sent }, { role: "assistant", content: [{ type: "text", text: "pi 的回答" }] }]
        : [{ role: "user", content: "旧" }, { role: "assistant", content: "旧的答" }],
    });
  };
  return { state, fetchImpl };
}

test("askPiReply posts the prompt and returns the first new assistant answer", async () => {
  const { state, fetchImpl } = fakeWorld();
  const answer = await askPiReply("s1", "帮我看看天气", { fetchImpl, pollMs: 1 });
  assert.equal(answer, "pi 的回答");
  assert.equal(state.sent, "帮我看看天气");
  assert.ok(state.posts === 1);
});

test("a rejected prompt surfaces as a busy error", async () => {
  const { fetchImpl } = fakeWorld({ rejectSend: true });
  await assert.rejects(() => askPiReply("s1", "x", { fetchImpl, pollMs: 1 }), /pi is busy/);
});
