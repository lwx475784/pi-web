import assert from "node:assert/strict";
import test from "node:test";

import { floatToInt16Base64, resampleToRate } from "./mic.ts";

test("the target rate is a passthrough", () => {
  const f = new Float32Array([0.5, -0.5]);
  assert.equal(resampleToRate(f, 16000), f);
});

test("halving the rate halves the length", () => {
  const f = new Float32Array(480);
  const out = resampleToRate(f, 48000, 16000);
  assert.equal(out.length, 160);
});

test("a constant signal resamples to the same constant", () => {
  const f = new Float32Array(300).fill(0.25);
  const out = resampleToRate(f, 44100);
  for (const value of out) assert.ok(Math.abs(value - 0.25) < 1e-6);
});

test("pcm16 encoding clips, is little-endian, and round-trips through base64", () => {
  const out = floatToInt16Base64(new Float32Array([0, 1, -1, 2, 0.5]));
  const bytes = Buffer.from(out, "base64");
  assert.equal(bytes.length, 10);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getInt16(0, true), 0);
  assert.equal(view.getInt16(2, true), 32767);
  assert.equal(view.getInt16(4, true), -32767); // -1 maps to -(2^15-1): the encoder scales symmetrically
  assert.equal(view.getInt16(6, true), 32767); // 2 clipped
  assert.equal(view.getInt16(8, true), 16384); // 0.5 * 32767 rounds to 16384 (banker's -> 16383.5 rounds to even)
});
