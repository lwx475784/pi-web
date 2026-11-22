import assert from "node:assert/strict";
import test from "node:test";

import { classifyTurn, containsAddress, createNearSpeechGate, frameLevelDb } from "./turn-gate.ts";

// A capture frame is 100 ms of 16 kHz mono PCM16: 3200 bytes, base64-encoded.
const FRAME_BYTES = 3200;
const pcmFrame = () => Buffer.from(new Uint8Array(FRAME_BYTES).fill(3)).toString("base64");
/** A buffer whose RMS sits at `db` dBFS (a square wave, so the level is exact). */
const samplesAt = (db) => {
  const amplitude = 10 ** (db / 20);
  return new Float32Array(1600).map((_, i) => (i % 2 ? -amplitude : amplitude));
};
/** Feed one frame at a given level; returns what the gate says to upload. */
const feed = (gate, db, frame = pcmFrame()) => gate.push(samplesAt(db), frame);
/** Whether any frame the gate returned carries audio rather than silence. */
const hasAudio = (frames) => frames.some((f) => Buffer.from(f, "base64").some((b) => b !== 0));

test("frameLevelDb reads digital silence and full scale", () => {
  assert.equal(frameLevelDb(new Float32Array(1600)), -120);
  assert.ok(Math.abs(frameLevelDb(samplesAt(0))) < 1e-6);
  assert.ok(Math.abs(frameLevelDb(samplesAt(-6)) + 6) < 0.01);
});

test("a closed gate uploads silence of the same length, so the server VAD still ends its turn", () => {
  const gate = createNearSpeechGate({ sensitivity: 45 });
  const frame = pcmFrame();
  const [quiet] = feed(gate, -68, frame);
  assert.equal(gate.open, false);
  const bytes = Buffer.from(quiet, "base64");
  assert.equal(bytes.length, FRAME_BYTES);
  assert.ok(bytes.every((b) => b === 0));
});

test("the gate opens on near speech, releasing the frames it held just before", () => {
  const gate = createNearSpeechGate({ sensitivity: 45, prerollFrames: 2 });
  const frame = pcmFrame();
  feed(gate, -68);
  feed(gate, -67);
  const onset = feed(gate, -18);
  assert.equal(gate.open, true);
  // Two held frames plus the one that tripped: no clipped word onset.
  assert.deepEqual(onset, [frame, frame, frame]);
  assert.deepEqual(feed(gate, -16), [frame]); // stays open while loud
});

test("a closing gate holds the tail of the sentence before it shuts", () => {
  const gate = createNearSpeechGate({ sensitivity: 45, holdFrames: 2 });
  const frame = pcmFrame();
  feed(gate, -18);
  assert.equal(gate.open, true);
  for (let i = 0; i < 2; i++) {
    const [held] = feed(gate, -70, frame);
    assert.equal(Buffer.from(held, "base64").some((b) => b !== 0), true, "tail still uploaded");
  }
  const [after] = feed(gate, -70, frame);
  assert.equal(gate.open, false);
  assert.ok(Buffer.from(after, "base64").every((b) => b === 0));
});

test("the loudest recent speech sets the bar, so a voice 20 dB under you is dropped", () => {
  const gate = createNearSpeechGate({ sensitivity: 45 });
  for (let i = 0; i < 4; i++) feed(gate, -60);      // a quiet room
  for (let i = 0; i < 20; i++) feed(gate, -16);     // you, at the phone
  assert.equal(gate.open, true);
  for (let i = 0; i < 8; i++) feed(gate, -60);      // you stop
  assert.equal(gate.open, false);
  let leaks = 0;
  for (let i = 0; i < 30; i++) if (hasAudio(feed(gate, -36))) leaks += 1;   // the living room
  assert.equal(leaks, 0, "the distant voice never reaches the server");
  for (let i = 0; i < 20; i++) feed(gate, -70);
  feed(gate, -18);                                  // and you are still heard
  assert.equal(gate.open, true);
});

test("a lone distant voice is still a voice: only the address word can veto that", () => {
  const gate = createNearSpeechGate({ sensitivity: 45 });
  let openedEarly = false;
  for (let i = 0; i < 4; i++) { feed(gate, -60); if (gate.open) openedEarly = true; }
  assert.equal(openedEarly, false, "nothing to answer until it speaks");
  for (let i = 0; i < 20; i++) feed(gate, -42);     // it talks, and nobody louder is around
  assert.equal(gate.open, true, "a lone voice at the far end still gets through");
});

test("sensitivity 0 lets a soft voice through, 100 wants near talk", () => {
  const off = createNearSpeechGate({ sensitivity: 0 });
  for (let i = 0; i < 30; i++) feed(off, -64);   // the room floor
  feed(off, -44);                                // a soft voice well over it
  assert.equal(off.open, true);

  const tight = createNearSpeechGate({ sensitivity: 100 });
  for (let i = 0; i < 30; i++) feed(tight, -64);
  const mid = feed(tight, -45);
  assert.equal(tight.open, false, "19 dB over the floor is not near talk at 100");
  assert.ok(Buffer.from(mid[0], "base64").every((b) => b === 0));
  feed(tight, -8);
  assert.equal(tight.open, true);
});

test("a dead frame is never uploaded as speech", () => {
  const gate = createNearSpeechGate({ sensitivity: 45 });
  assert.deepEqual(gate.push(new Float32Array(1600), ""), []);
});

test("classifyTurn swallows interjections, hallucinated stray words and non-speech", () => {
  for (const noise of ["嗯", "哦。", "uh", "oder", "yo", "ha", "！", "  ", "help"]) {
    assert.equal(classifyTurn(noise).accept, false, `${noise} should not start a turn`);
  }
  for (const real of ["帮我看看桌面上有什么文件", "今天天气怎么样", "Compact the context", "hello there my friend"]) {
    assert.equal(classifyTurn(real).accept, true, `${real} should be answered`);
  }
});

test("classifyTurn rejects a turn whose audio length says it is not speech", () => {
  assert.deepEqual(classifyTurn("帮我看看文件", 0.28), { accept: false, reason: "short" });
  assert.deepEqual(classifyTurn("帮我看看文件", 1.4), { accept: true });
  // No duration reported: the text rules alone decide.
  assert.equal(classifyTurn("帮我看看文件").accept, true);
});

test("an address word gates every turn, loosely matched", () => {
  const opts = { wakeWord: "静静" };
  assert.deepEqual(classifyTurn("今天天气怎么样", 2, opts), { accept: false, reason: "address" });
  assert.equal(classifyTurn("静静，今天天气怎么样", 2, opts).accept, true);
  assert.equal(classifyTurn("静 静 帮我个忙", 2, opts).accept, true);
  assert.equal(classifyTurn("喂静静在吗", 2, opts).accept, true);
  assert.equal(classifyTurn("帮我个忙", 2, { wakeWord: "  " }).accept, true);
});

test("containsAddress ignores spacing, punctuation and case", () => {
  assert.equal(containsAddress("Jingjing, 帮我", "jingjing"), true);
  assert.equal(containsAddress("静静！", "静静。"), true);
  assert.equal(containsAddress("帮我", ""), false);
  assert.equal(containsAddress("", "静静"), false);
});
