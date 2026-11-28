import assert from "node:assert/strict";
import test from "node:test";

import { joinTranscript } from "./text.ts";

test("an empty segment inserts nothing", () => {
  assert.equal(joinTranscript("anything", "   "), "");
});

test("the first segment is taken as-is", () => {
  assert.equal(joinTranscript("", "  你好  "), "你好");
});

test("latin words are joined with a space", () => {
  assert.equal(joinTranscript("hello", "world"), " world");
});

test("CJK runs join flush, with or with out punctuation", () => {
  assert.equal(joinTranscript("你好", "世界"), "世界");
  assert.equal(joinTranscript("你好。", "今天"), "今天");
  assert.equal(joinTranscript("帮我算", "23×47"), "23×47");
});

test("existing whitespace is kept, not doubled", () => {
  assert.equal(joinTranscript("hello ", "world"), "world");
  assert.equal(joinTranscript("line1\n", "line2"), "line2");
});
