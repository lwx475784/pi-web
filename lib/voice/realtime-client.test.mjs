import assert from "node:assert/strict";
import test from "node:test";

import { ENDPOINT_SILENCE_MS, RealtimeDictationClient, SERVER_TURN_HOLD_MS, flushWaitMs, silenceChunksToCommit } from "./realtime-client.ts";

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
  // The window the server endpointings on, asked for explicitly: left unset the server
  // runs its 300 ms minimum, which cut the tail off real sentences (2026-11-28).
  assert.equal(update.session.audio.input.turn_detection.silence_duration_ms, ENDPOINT_SILENCE_MS);
  assert.equal(update.session.audio.input.turn_detection.create_response, undefined);
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
  // Dictation leaves turn-taking to the server: it must not ask for a response
  // of its own, or the server's auto-answer comes back as a refusal.
  assert.ok(!ws.sent.some((m) => m.type === "response.create"));
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

test("conversation mode keeps responses, passes tools and instructions", async () => {
  const audio = [];
  const assistant = [];
  const calls = [];
  const started = [];
  const client = new RealtimeDictationClient(["ws://one/v1/realtime"], {
    onSegment: () => {}, onPartial: () => {},
    onAudioChunk: (b) => audio.push(b),
    onAssistantDelta: (d) => assistant.push(d),
    onFunctionCall: (c) => calls.push(c),
    onSpeechStarted: () => started.push(1),
  }, {
    WebSocketImpl: FakeWS,
    cancelResponses: false,
    tools: [{ type: "function", name: "ask_pi" }],
    instructions: "speak chinese",
  });
  await client.connect();
  const ws = FakeWS.instances.at(-1);
  const update = ws.sent.find((m) => m.type === "session.update");
  assert.equal(update.session.instructions, "speak chinese");
  assert.equal(update.session.tools[0].name, "ask_pi");
  ws.emit({ type: "input_audio_buffer.speech_started" });
  ws.emit({ type: "response.created", response: { id: "r1" } });
  ws.emit({ type: "response.output_audio.delta", delta: "AABC" });
  ws.emit({ type: "response.output_audio_transcript.delta", delta: "好的" });
  ws.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "ask_pi", arguments: "{\"question\":\"几点\"}" });
  assert.equal(started.length, 1);
  assert.ok(!ws.sent.some((m) => m.type === "response.cancel"));
  assert.deepEqual(audio, ["AABC"]);
  assert.deepEqual(assistant, ["好的"]);
  assert.deepEqual(calls, [{ callId: "c1", name: "ask_pi", argumentsJson: "{\"question\":\"几点\"}" }]);
});

test("sendFunctionOutput posts the result and asks for a spoken response", async () => {
  const { client } = harness({ onSegment: () => {}, onPartial: () => {} });
  await client.connect();
  const ws = FakeWS.instances.at(-1);
  client.sendFunctionOutput("c1", "答案是 42", true);
  const create = ws.sent.find((m) => m.type === "conversation.item.create");
  assert.equal(create.item.type, "function_call_output");
  assert.equal(create.item.call_id, "c1");
  assert.equal(create.item.output, "答案是 42");
  assert.ok(ws.sent.some((m) => m.type === "response.create"));
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

// --- the call's turn-taking gate -------------------------------------------------

/** A conversation client that drives generation itself. */
async function gated(handlers = {}, clientOpts = {}) {
  const client = new RealtimeDictationClient(["ws://one/v1/realtime"], {
    onSegment: () => {}, onPartial: () => {}, ...handlers,
  }, {
    WebSocketImpl: FakeWS,
    cancelResponses: false,
    gateResponses: true,
    tools: [{ type: "function", name: "ask_pi" }],
    instructions: "speak chinese",
    ...clientOpts,
  });
  await client.connect();
  return { client, ws: FakeWS.instances.at(-1) };
}

const creates = (ws) => ws.sent.filter((m) => m.type === "response.create").length;
const sayTurn = (ws, text = "你好") => ws.emit({
  type: "conversation.item.input_audio_transcription.completed", item_id: `i${ws.sent.length}`, transcript: text,
});

test("gated mode tells the server to stop answering on its own", async () => {
  const { ws } = await gated();
  const update = ws.sent.find((m) => m.type === "session.update");
  assert.equal(update.session.audio.input.turn_detection.create_response, false);
});

test("a committed turn asks for exactly one reply, and so does the next", async () => {
  const { client, ws } = await gated();
  assert.equal(creates(ws), 0);
  sayTurn(ws);
  assert.equal(creates(ws), 1);
  ws.emit({ type: "response.created", response: { id: "r1" } });
  ws.emit({ type: "response.done", response: { status: "completed" } });
  sayTurn(ws, "再问一次");
  assert.equal(creates(ws), 2);
  // The client asked, so it must not also cancel what it asked for.
  assert.equal(ws.sent.filter((m) => m.type === "response.cancel").length, 0);
  assert.equal(client.connected, true);
});

test("a turn the caller vetoes is reported but never answered", async () => {
  const segments = [];
  const vetoed = [];
  const { ws } = await gated({
    onSegment: (text, info) => segments.push([text, info.seconds, info.accepted]),
    acceptTurn: (text, seconds) => { vetoed.push([text, seconds]); return text.startsWith("帮我"); },
  });
  ws.emit({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "noise-1",
    transcript: "oder",
    usage: { type: "duration", seconds: 1.2 },
  });
  assert.equal(creates(ws), 0, "a swallowed turn asks for no reply");
  assert.deepEqual(vetoed, [["oder", 1.2]]);
  assert.deepEqual(segments, [["oder", 1.2, false]]);
  sayTurn(ws, "帮我看看桌面上有什么文件");
  assert.equal(creates(ws), 1);
  assert.deepEqual(segments.at(-1), ["帮我看看桌面上有什么文件", 0, true]);
});

test("a tool call holds every reply until its output lands", async () => {
  const { client, ws } = await gated();
  sayTurn(ws, "查一下文件");
  ws.emit({ type: "response.created", response: { id: "r1" } });
  ws.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "ask_pi", arguments: "{\"question\":\"文件\"}" });
  ws.emit({ type: "response.done", response: { status: "completed" } });
  // The user keeps talking while pi works: nothing can be generated yet, and
  // asking anyway is what the server answers with an error.
  sayTurn(ws, "算了");
  assert.equal(creates(ws), 1);
  client.sendFunctionOutput("c1", JSON.stringify({ state: "started" }), true);
  assert.equal(creates(ws), 2);
  const last = ws.sent.at(-1);
  assert.equal(last.type, "response.create");
  assert.deepEqual(ws.sent.at(-2), {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: "c1", output: "{\"state\":\"started\"}" },
  });
  // An output the caller does not want spoken leaves the conversation alone.
  client.sendFunctionOutput("c2", "unknown tool call", false);
  assert.equal(creates(ws), 2);
});

test("a reply asked for while the voice layer speaks waits for its turn", async () => {
  const { client, ws } = await gated();
  sayTurn(ws);
  ws.emit({ type: "response.created", response: { id: "r1" } });
  client.notify("pi 的回答：在 Z 盘");
  assert.equal(creates(ws), 1); // still the one from the user turn
  ws.emit({ type: "response.done", response: { status: "completed" } });
  assert.equal(creates(ws), 2);
  const items = ws.sent.filter((m) => m.type === "conversation.item.create");
  assert.match(items.at(-1).item.content[0].text, /^\[background event, not said by the user\] pi 的回答：在 Z 盘$/);
});

test("an announcement reports its tag only once the text reaches the model", async () => {
  const heard = [];
  const { client, ws } = await gated({ onNoticeInjected: (tag) => heard.push(tag) });
  ws.emit({ type: "input_audio_buffer.speech_started" });
  client.notify("pi 的回答：在 Z 盘", "ledger-1");
  assert.deepEqual(heard, [], "queued is not heard: a hang-up here leaves the entry unread");
  ws.emit({ type: "input_audio_buffer.speech_stopped" });
  assert.deepEqual(heard, ["ledger-1"]);

  // An announcement the user cancelled reports nothing, and an untagged one (the
  // ledger unreachable, so no receipt is possible) still speaks.
  client.notify("pi 说完了");
  client.dropNotifications();
  ws.emit({ type: "input_audio_buffer.speech_started" });
  client.notify("pi 又答完了", "ledger-2");
  ws.emit({ type: "input_audio_buffer.speech_stopped" });
  assert.deepEqual(heard, ["ledger-1"], "dropNotifications must not report a cancelled notice as heard");
});

test("releasing the mic first lets the sentence in flight land", async () => {
  const partials = [];
  const { client, ws } = await gated({ onPartial: (text) => partials.push(text) });
  ws.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "帮我查一" });
  ws.emit({ type: "input_audio_buffer.speech_started" });
  assert.deepEqual(partials.at(-1), "帮我查一");
  setTimeout(() => ws.emit({ type: "input_audio_buffer.committed" }), 5);
  const before = ws.sent.length;
  assert.equal(await client.flushSpeakingTurn(200), true);
  // Silence is what the server reads as the end of a turn: without it the utterance is
  // never committed and `speaking` stays true forever — and the stream must be longer than
  // the window in session.update, or the flush commits nothing and discards the sentence.
  const appended = ws.sent.slice(before).filter((m) => m.type === "input_audio_buffer.append");
  assert.ok(appended.length >= silenceChunksToCommit(), `${appended.length} silence frames`);

  // It landed, so its transcript is still the user's sentence, and an announcement can go out.
  ws.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "帮我查一下" });
  assert.equal(partials.at(-1), "", "the settled sentence leaves the live caption empty again");
  client.notify("pi 说完了", "");
  assert.equal(creates(ws), 1);
});

// The trap this guards: the window in session.update, the silence streamed at release, and
// the wait for the commit are one mechanism. Someone widening only the first would turn
// "the tail gets cut" into "the tail gets dropped" — and no server is involved to notice.
test("the release flush clears the endpointing window it configured, with room to spare", () => {
  const streamedMs = silenceChunksToCommit() * 100;
  assert.ok(streamedMs > ENDPOINT_SILENCE_MS, `${streamedMs} ms of streamed silence must exceed the ${ENDPOINT_SILENCE_MS} ms window`);
  assert.ok(flushWaitMs() > streamedMs, `the ${flushWaitMs()} ms wait must outlast the ${streamedMs} ms it streams`);
  // 800 ms is not a local guess: it is the OpenAI Realtime convention (range 200-6000), and it
  // is what the live server needs to keep one sentence in one segment — at its own 300 ms
  // default the VAD logged soft-ended(segment=2368ms) then reopened the same turn (rev=1,
  // segment=2208ms), i.e. the sentence was cut in half. Measured 2026-11-28 in Z:\voice\s2s\s2s.log.
  assert.ok(ENDPOINT_SILENCE_MS >= 200 && ENDPOINT_SILENCE_MS <= 6000, "outside the documented range");
  // And the wait has to outlast the server's Smart Turn hold (incomplete-delay 600 + reopen
  // 2000, both defaults in VAD/vad_handler.py), or the release path discards the sentence the
  // silence was streamed to save.
  assert.ok(flushWaitMs() > SERVER_TURN_HOLD_MS, `${flushWaitMs()} ms must outlast the ${SERVER_TURN_HOLD_MS} ms the server holds a turn`);
});

test("a sentence that never commits is dropped instead of parking every later announcement", async () => {
  const partials = [];
  const { client, ws } = await gated({ onPartial: (text) => partials.push(text) });
  ws.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "说到一半" });
  ws.emit({ type: "input_audio_buffer.speech_started" });
  assert.equal(await client.flushSpeakingTurn(5), false);

  // Dropped means dropped: the half-word must not resurface in the next call's caption, and a
  // later announcement must not sit behind a sentence nobody is speaking.
  assert.equal(partials.at(-1), "");
  client.notify("pi 说完了", "");
  assert.equal(creates(ws), 1);
  // The voice layer said it; only then is the way clear for the next sentence's reply.
  ws.emit({ type: "response.created", response: { id: "r1" } });
  ws.emit({ type: "response.done", response: { status: "completed" } });
  ws.emit({ type: "input_audio_buffer.speech_started" });
  ws.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: "u2", delta: "下一条" });
  assert.equal(partials.at(-1), "下一条", "only the new sentence is live");
  ws.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "下一条" });
  assert.equal(creates(ws), 2);
});

test("an announcement waits for the sentence the user is in the middle of", async () => {
  const { client, ws } = await gated();
  ws.emit({ type: "input_audio_buffer.speech_started" });
  client.notify("pi 说完了");
  assert.equal(creates(ws), 0);
  ws.emit({ type: "input_audio_buffer.speech_stopped" });
  assert.equal(creates(ws), 1);
});

test("a committed turn frees an announcement even without a soft-end", async () => {
  const { client, ws } = await gated();
  ws.emit({ type: "input_audio_buffer.speech_started" });
  client.notify("pi 说完了");
  assert.equal(creates(ws), 0);
  ws.emit({ type: "input_audio_buffer.committed" });
  assert.equal(creates(ws), 1);
});

test("dropNotifications forgets announcements the user cancelled", async () => {
  const { client, ws } = await gated();
  sayTurn(ws, "查一下");
  ws.emit({ type: "response.created", response: { id: "r1" } });
  ws.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "ask_pi", arguments: "{}" });
  ws.emit({ type: "response.done", response: { status: "completed" } });
  client.sendFunctionOutput("c1", "{\"state\":\"started\"}", true);
  ws.emit({ type: "response.created", response: { id: "r2" } });
  client.notify("pi 的回答：…");
  client.dropNotifications();
  ws.emit({ type: "response.done", response: { status: "completed" } });
  // Only the two creates the conversation itself owed; nothing announces a
  // result the user stopped for.
  assert.equal(creates(ws), 2);
  assert.ok(!ws.sent.some((m) => m.type === "conversation.item.create" && m.item?.content?.[0]?.text?.includes("background event")));
});

/** Wait until `check()` is true, so the stall tests read as state changes, not as sleeps. */
async function until(check, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return false;
}

test("a create the server neither opens nor refuses is retried, not held forever", async () => {
  const errors = [];
  const { ws } = await gated({ onError: (e) => errors.push(e.code) }, { createAckTimeoutMs: 5 });
  sayTurn(ws);
  assert.equal(creates(ws), 1);
  // The server goes quiet: no response.created, no error. Before ADR 0008 #11 this was a
  // deadlock — `createOpen` stayed true and every later announcement queued behind a reply that
  // was never coming.
  assert.ok(await until(() => creates(ws) >= 2), "the lost create is asked for again");
  assert.deepEqual(errors, [], "one stall is a retry, not an outage");

  // An answer that does arrive resets the count, so a later lone stall is not already the third.
  ws.emit({ type: "response.created", response: { id: "r1" } });
  ws.emit({ type: "response.done", response: { status: "completed" } });
  sayTurn(ws, "再说一句");
  assert.ok(await until(() => creates(ws) >= 4));
  assert.deepEqual(errors, [], "the retried creates answered, so nothing escalated");
});

test("three unanswered creates end the call instead of leaving it looking live and deaf", async () => {
  const errors = [];
  const { ws } = await gated({ onError: (e) => errors.push(e.code) }, { createAckTimeoutMs: 4 });
  sayTurn(ws);
  assert.ok(await until(() => errors.includes("connection_stalled")));
  assert.equal(creates(ws), 3, "the call stops asking once it is declared stalled");
  assert.equal(errors.filter((code) => code === "connection_stalled").length, 1, "the outage is reported once");
});

test("a create the server refuses stays owed and goes out again", async () => {
  const { client, ws } = await gated();
  sayTurn(ws);
  ws.emit({ type: "response.created", response: { id: "r1" } });
  ws.emit({ type: "response.function_call_arguments.done", call_id: "c1", name: "ask_pi", arguments: "{}" });
  ws.emit({ type: "response.done", response: { status: "completed" } });
  sayTurn(ws, "算了");
  client.sendFunctionOutput("c1", "done", true); // the second create
  ws.emit({ type: "error", error: { code: "function_call_output_pending", message: "Cannot create a response while function call outputs are pending." } });
  assert.equal(creates(ws), 2);
  // The refusal means the reply is still owed: the tool answer retries it.
  client.sendFunctionOutput("c2", "late", true);
  assert.equal(creates(ws), 3);
});

test("audio that arrives after its response closed is dropped", async () => {
  const audio = [];
  const text = [];
  const { client, ws } = await gated({
    onAudioChunk: (b) => audio.push(b),
    onAssistantDelta: (d) => text.push(d),
    onResponseStarted: () => audio.push("open"),
    onResponseDone: () => audio.push("closed"),
  });
  ws.emit({ type: "response.created", response: { id: "r1" } });
  ws.emit({ type: "response.output_audio.delta", delta: "AABC" });
  ws.emit({ type: "response.output_audio_transcript.delta", delta: "说了" });
  ws.emit({ type: "response.done", response: { status: "cancelled" } });
  // The barge-in flushed the player; the tail the server had already
  // synthesized must not start it up again.
  ws.emit({ type: "response.output_audio.delta", delta: "DDDE" });
  ws.emit({ type: "response.output_audio_transcript.delta", delta: "迟到" });
  assert.deepEqual(audio, ["open", "AABC", "closed"]);
  assert.deepEqual(text, ["说了"]);
  assert.equal(client.connected, true);
});
