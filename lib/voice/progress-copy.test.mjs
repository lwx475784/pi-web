import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_FRESH_MS,
  classifyActivity,
  classifyTool,
  pickProgressClass,
  progressLine,
  PROGRESS_AFTER_MS,
} from "./progress-copy.ts";

test("the first progress line is owed after two minutes, not before", () => {
  assert.equal(PROGRESS_AFTER_MS, 120_000);
});

test("tool calls map to phrases a person would say, not to tool names", () => {
  assert.equal(classifyTool("read"), "reading");
  assert.equal(classifyTool("grep"), "reading");
  assert.equal(classifyTool("web_search"), "searching");
  assert.equal(classifyTool("edit"), "writing");
  assert.equal(classifyTool("bash"), "running");
  assert.equal(classifyTool("subagent"), "delegating");
  assert.equal(classifyTool("mcp__hindsight_knowledge__recall"), null);
  assert.equal(classifyTool(""), null);
  assert.equal(classifyTool(undefined), null);
});

test("only a tool starting is an activity worth naming", () => {
  assert.deepEqual(classifyActivity({ type: "tool_execution_start", toolName: "read" }), "reading");
  assert.equal(classifyActivity({ type: "tool_execution_end", toolName: "read" }), null);
  assert.equal(classifyActivity({ type: "message_update" }), null);
  assert.equal(classifyActivity(null), null);
  assert.equal(classifyActivity("not an event"), null);
});

test("a stale activity degrades to the honest phrase", () => {
  const now = 1_800_000_000_000;
  assert.equal(pickProgressClass({ cls: "running", at: now - 5_000 }, now), "running");
  assert.equal(pickProgressClass({ cls: "running", at: now - ACTIVITY_FRESH_MS - 1 }, now), "thinking");
  assert.equal(pickProgressClass(null, now), "thinking");
});

test("the line says how long, what it is doing, and that the user may walk away", () => {
  const line = progressLine(125_000, "reading");
  assert.match(line, /2 分钟/);
  assert.match(line, /在读你的文件/);
  // Rounding down: "3 分钟" when it has been 2:05 overstates, and an overstated wait reads like a lie.
  assert.doesNotMatch(line, /3 分钟/);
  assert.match(progressLine(49_000, "thinking"), /1 分钟/);
  for (const cls of ["reading", "searching", "writing", "running", "delegating", "thinking"]) {
    assert.ok(progressLine(180_000, cls).includes("3 分钟"));
  }
});
