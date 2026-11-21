import assert from "node:assert/strict";
import test from "node:test";

import { RealtimeDictationClient } from "./realtime-client.ts";

class FakeWS {
  constructor(url) {
    FakeWS.instances.push(this);
    this.url = url;
    this.sent = [];
    this.closed = false;
    queueMicrotask(() => {
      if (FakeWS.refuseToOpen.has(url)) return;
      this.onopen?.();
      this.emit({ type: "session.created", session: {} });
    });
  }

  static instances = [];
  static refuseToOpen = new Set();

  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.onclose?.(); }
  emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
}

function harness(handlers = {}, opts = {}) {
  const client = new RealtimeDictationClient(["ws://one/v1/realtime"], handlers, {
    WebSocketImpl: FakeWS,
    ...opts,
  });
  return { client };
}

test("connect waits for session.created and configures server VAD plus snapshots", async () => {
  const { client } = harness();
  const url = await client.connect();
  assert.equal(url, "ws://one/v1/realtime");
  const ws = FakeWS.instances.at(-1);
  const update = ws.sent.find((m) => m.type === "session.update");
  assert.equal(update.session.audio.input.turn_detection.type, "server_vad");
  assert.ok(update.session.extensions.includes("speech_to_speech.input_audio_transcription.snapshot"));
});

test("a candidate that never opens falls through to the next", async () => {
  FakeWS.refuseToOpen.add("ws://one/v1/realtime");
  const client = new RealtimeDictationClient(["ws://one/v1/realtime", "ws://two/v1/realtime"], {}, {
    WebSocketImpl: FakeWS,
    connectTimeoutMs: 60,
  });
  const url = await client.connect();
  assert.equal(url, "ws://two/v1/realtime");
  FakeWS.refuseToOpen.clear();
});

test("deltas accumulate into partials and the final transcript is authoritative", async () => {
  const segments = [];
  const partials = [];
  const { client } = harness({ onSegment: (t) => segments.push(t), onPartial: (t) => partials.push(t) });
  await client.connect();
  const ws = FakeWS.instances.at(-1);
  ws.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "i1", text: "今天" });
  ws.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "i1", text: "星期几" });
  ws.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "今天星期几。" });
  assert.deepEqual(segments, ["今天星期几。"]);
  assert.equal(partials.at(-1), "");
  // A duplicate completion for the same item must not fire the segment twice.
  ws.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "今天星期几。" });
  assert.equal(segments.length, 1);
});

test("a snapshot replaces the accumulated hypothesis for display", async () => {
  const partials = [];
  const { client } = harness({ onSegment: () => {}, onPartial: (t) => partials.push(t) });
  await client.connect();
  const ws = FakeWS.instances.at(-1);
  ws.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "i1", text: "你好" });
  ws.emit({ type: "speech_to_speech.input_audio_transcription.snapshot", item_id: "i1", transcript: "你好世界" });
  assert.equal(partials.at(-1), "你好世界");
});

test("dictation cancels the auto-generated assistant response", async () => {
  const { client } = harness({ onSegment: () => {}, onPartial: () => {} });
  await client.connect();
  const ws = FakeWS.instances.at(-1);
  ws.emit({ type: "response.created", response: { id: "r1" } });
  assert.ok(ws.sent.some((m) => m.type === "response.cancel"));
});

test("session_limit_reached surfaces as a busy error", async () => {
  const errors = [];
  const { client } = harness({ onSegment: () => {}, onPartial: () => {}, onError: (e) => errors.push(e) });
  await client.connect();
  const ws = FakeWS.instances.at(-1);
  ws.emit({ type: "error", error: { code: "session_limit_reached", message: "queue full" } });
  assert.equal(errors[0].code, "session_limit_reached");
  assert.match(errors[0].message, /busy/);
});

test("stop flushes silence so the server VAD commits the trailing utterance", async () => {
  const { client } = harness();
  await client.connect();
  client.sendSilenceChunks(2);
  const ws = FakeWS.instances.at(-1);
  const appends = ws.sent.filter((m) => m.type === "input_audio_buffer.append");
  assert.equal(appends.length, 2);
  assert.ok(Buffer.from(appends[0].audio, "base64").every((b) => b === 0));
});
