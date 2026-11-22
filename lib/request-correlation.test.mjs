import assert from "node:assert/strict";
import test from "node:test";

import {
  claimRequestId,
  extractMessageText,
  normalizeRequestId,
  PENDING_REQUEST_ID_LIMIT,
  rememberRequestId,
} from "./request-correlation.ts";

test("normalizeRequestId takes an opaque id and refuses everything else", () => {
  assert.equal(normalizeRequestId("01a2021b-72d2"), "01a2021b-72d2");
  assert.equal(normalizeRequestId("  r-1  "), "r-1");
  for (const bad of [undefined, null, 7, "", "   ", "带中文", "a".repeat(65), "r/1", "r 1"]) {
    assert.equal(normalizeRequestId(bad), undefined, String(bad));
  }
});

test("extractMessageText reads both shapes pi carries a user message in", () => {
  assert.equal(extractMessageText({ role: "user", content: "纯文本" }), "纯文本");
  assert.equal(extractMessageText({ role: "user", content: [{ type: "image" }, { type: "text", text: "块里的文本" }] }), "块里的文本");
  assert.equal(extractMessageText({ role: "assistant", content: [] }), "");
  assert.equal(extractMessageText(undefined), "");
});

test("claimRequestId pairs the delivered message with the submission that named it", () => {
  const pending = [{ requestId: "r-1", text: "查一下定时任务" }];
  const claimed = claimRequestId(pending, "查一下定时任务");
  assert.equal(claimed?.requestId, "r-1");
  assert.equal(pending.length, 0, "a claimed id is gone: it cannot be echoed onto a second message");
});

test("two identical asks are answered in the order they were sent", () => {
  const pending = [{ requestId: "r-1", text: "同一个问题" }, { requestId: "r-2", text: "同一个问题" }];
  assert.equal(claimRequestId(pending, "同一个问题")?.requestId, "r-1");
  assert.equal(claimRequestId(pending, "同一个问题")?.requestId, "r-2");
  assert.equal(claimRequestId(pending, "同一个问题"), null);
});

test("a reflowed prompt still matches the text it was submitted as", () => {
  const pending = [{ requestId: "r-1", text: "第一行\n   第二行" }];
  assert.equal(claimRequestId(pending, "第一行 第二行")?.requestId, "r-1");
});

test("an unmatched message claims nothing, so a rewrite cannot mis-pair an answer", () => {
  const pending = [{ requestId: "r-1", text: "/skill:foo 展开后的样子完全不同" }];
  assert.equal(claimRequestId(pending, "<skill name=\"foo\">…</skill>"), null);
  assert.equal(pending.length, 1, "the id stays for the delivery that does match, or expires by overflow");
  assert.equal(claimRequestId(pending, ""), null);
  assert.equal(claimRequestId([], "任意"), null);
});

test("rememberRequestId caps the list by dropping the oldest, and ignores a missing id", () => {
  const pending = [];
  for (let i = 0; i < PENDING_REQUEST_ID_LIMIT + 3; i++) rememberRequestId(pending, `r-${i}`, `问 ${i}`);
  assert.equal(pending.length, PENDING_REQUEST_ID_LIMIT);
  assert.equal(pending[0].requestId, `r-3`);
  assert.equal(claimRequestId(pending, `r-3 sentinel`)?.requestId, undefined);
  assert.equal(claimRequestId(pending, `问 3`)?.requestId, "r-3");

  const untouched = [];
  rememberRequestId(untouched, undefined, "没有 id");
  assert.deepEqual(untouched, []);
});
