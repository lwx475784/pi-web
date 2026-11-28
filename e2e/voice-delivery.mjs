#!/usr/bin/env node
// Voice-call delivery regression (ADR 0008 #11): drive the real server with real asks and
// measure what the user would actually have heard.
//
//   node e2e/voice-delivery.mjs --limit 20 --report test-results/voice-delivery.md
//   node e2e/voice-delivery.mjs --limit 6 --speech        # also: synth audio → realtime WS
//
// Two things are measured, and they are not the same thing:
//
//   1. **Pairing** — the bar the interview set. Every ask carries a token only its answer can
//      repeat ("编号 07"). The bridge must read the answer of *that* run: an answer whose token
//      does not match is mis-pairing, an answer that never arrives is a miss. Mis-pairing under
//      five percent is the gate; the failure this replaces was silent, and a wrong answer spoken
//      aloud is indistinguishable from a right one.
//   2. **Latency** (`--speech`) — OmniVoice synthesizes each phrase through voice-gen, the script
//      streams it into the speech-to-speech WebSocket as 16 kHz frames, and times the end of the
//      audio to the first response audio delta. That is close to spoken-to-heard; the server's own
//      E2E figure (2.82 s median in the 2026-11-22 logs) is not, and the two must not be quoted
//      against each other.
//
// Runs against a *deployed* pi-web: it restarts the moment this script finishes, so point it at
// the build you intend to ship.
//
// The speech leg drives the pipeline with the *plain* voice settings — it does not install the
// panel's `ask_pi` tool or the voice-layer instructions — so what it times is "end of utterance to
// first audible frame" for a chit-chat reply (measured 2026-11-22: 3.6–4.7 s, median 4.2 s, against
// a 2.82 s figure inside the server and an industry target near 0.5–0.8 s). The delegation path is
// judged by the protocol leg, which does carry the requestId and reads the same events the page does.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}
const has = (name) => args.includes(`--${name}`);

const BASE = (flag("base-url", process.env.PI_WEB_BASE_URL || "http://127.0.0.1:30141")).replace(/\/$/, "");
const REALTIME = flag("realtime-url", process.env.PI_VOICE_REALTIME_URL || "ws://192.168.124.194:8765/v1/realtime");
const CWD = flag("cwd", process.cwd());
const LIMIT = Math.max(1, Math.min(40, Number(flag("limit", "20"))));
const REPORT = flag("report", "");
// `Number("180_000")` is NaN, and `Math.max(30_000, NaN)` is NaN too — which made every wait
// expire instantly and every ask read back as "empty answer". Defaults are parsed from digits
// only, and a NaN falls back rather than silently becoming a zero-timeout.
const ASK_TIMEOUT_MS = (() => {
  const raw = Number(flag("ask-timeout-ms", "180000"));
  return Number.isFinite(raw) && raw > 0 ? Math.max(30_000, raw) : 180_000;
})();
const SPEECH = has("speech");

/** Tokens of the asks already put: an answer carrying one of these is somebody else's. */
function earlierTokens(index) {
  return Array.from({ length: index }, (_, i) => scriptedAsk(i).token);
}

/** One ask per row. The token is what makes a wrong answer detectable without a human listening. */
function scriptedAsk(index) {
  const token = `QN${String(index + 1).padStart(2, "0")}`;
  const phrasings = [
    "只回答两个词：这个编号，加“完成”。编号是",
    "不要解释，只输出编号和“完成”两个字。编号",
    "用最小回答确认这个编号：",
  ];
  const phrase = phrasings[index % phrasings.length];
  return { token, text: `${phrase}${token}` };
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body?.sessionId) throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const post = (path, body) => api(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * One reader over the session's SSE stream, shared by every ask: the same stream the page keeps,
 * so the harness sees exactly the events the voice bridge will see.
 */
function openEventStream(sessionId) {
  const controller = new AbortController();
  const listeners = new Set();
  const state = { connected: false, error: null };
  void (async () => {
    const res = await fetch(`${BASE}/api/agent/${encodeURIComponent(sessionId)}/events`, { signal: controller.signal });
    if (!res.ok || !res.body) {
      state.error = `http ${res.status}`;
      for (const listener of listeners) listener({ type: "stream_error", status: res.status });
      return;
    }
    state.connected = true;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
        const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (!data) continue;
        try {
          const event = JSON.parse(data);
          for (const listener of listeners) listener(event);
        } catch { /* a partial frame or an SSE comment */ }
      }
    }
  })().catch(() => { /* aborted */ });
  return {
    state,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { controller.abort(); listeners.clear(); },
  };
}

/** Wait for the event that names *this* submission, ignoring every other client's run. */
function awaitRun(stream, requestId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve({ ok: false, reason: "timeout" }); }, timeoutMs);
    const seen = { anchorEntryId: null };
    const off = stream.onEvent((event) => {
      if (event?.requestId !== requestId) {
        if (event?.type === "stream_error") { clearTimeout(timer); off(); resolve({ ok: false, reason: "stream" }); }
        return;
      }
      if (event.type === "user_message_entry") { seen.anchorEntryId = event.entryId ?? null; return; }
      if (event.type === "prompt_done" || event.type === "prompt_error") {
        clearTimeout(timer);
        off();
        resolve({ ok: true, anchorEntryId: seen.anchorEntryId, aborted: event.aborted === true, errored: event.type === "prompt_error" });
      }
    });
  });
}

async function readNewestAnswer(sessionId) {
  const body = await api(`/api/sessions/${encodeURIComponent(sessionId)}/context?tail=6`);
  const messages = body?.context?.messages ?? (Array.isArray(body?.context) ? body.context : []);
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    const message = entry?.message ?? entry;
    if (message?.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n").trim();
      if (text) return text;
    }
  }
  return "";
}

/** The ledger the voice panel writes: the harness plays the page's part to prove the route works. */
async function ledgerSmoke(sessionId) {
  const requestId = randomUUID().slice(0, 24);
  const created = await post(`/api/sessions/${encodeURIComponent(sessionId)}/voice-announcements`, { requestId, kind: "answer", question: "harness", text: "harness answer" });
  const entry = (created?.announcements ?? []).find((candidate) => candidate.requestId === requestId);
  if (!entry) throw new Error("ledger POST did not store the entry");
  const read = await api(`/api/sessions/${encodeURIComponent(sessionId)}/voice-announcements`);
  const unread = (read?.unread ?? []).some((candidate) => candidate.id === entry.id);
  const marked = await api(`/api/sessions/${encodeURIComponent(sessionId)}/voice-announcements`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [entry.id] }) });
  const stillUnread = (marked?.unread ?? []).some((candidate) => candidate.id === entry.id);
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/voice-announcements`, { method: "DELETE" });
  return { stored: true, unreadBefore: unread, clearedAfterMark: !stillUnread };
}

// ---------------------------------------------------------------------------------------------
// The speech leg: synthesized Chinese into the realtime WebSocket, timed like a listener would.
// ---------------------------------------------------------------------------------------------

/** Minimal RIFF parser: voice-gen hands back whatever OmniVoice produced, so read the header. */
function readWav(path) {
  const bytes = readFileSync(path);
  if (bytes.toString("latin1", 0, 4) !== "RIFF") throw new Error(`${path} is not a RIFF wav`);
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") fmt = { channels: bytes.readUInt16LE(offset + 10), rate: bytes.readUInt32LE(offset + 12), bits: bytes.readUInt16LE(offset + 22) };
    else if (id === "data") data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path} has no decodable PCM`);
  const float = new Float32Array(data.length / (fmt.bits / 8));
  if (fmt.bits !== 8 && fmt.bits !== 16 && fmt.bits !== 32) throw new Error(`${path}: unsupported wav bit depth ${fmt.bits}`);
  for (let i = 0; i < float.length; i++) {
    let sample = 0;
    for (let channel = 0; channel < fmt.channels; channel++) {
      const index = i * fmt.channels + channel;
      if (fmt.bits === 16) sample += data.readInt16LE(index * 2) / 0x8000;
      else if (fmt.bits === 32) sample += data.readFloatLE(index * 4);
      else sample += (data.readUInt8(index) - 128) / 128;
    }
    float[i] = sample / fmt.channels;
  }
  return { samples: float, rate: fmt.rate };
}

function resample(samples, from, to = 16000) {
  if (from === to) return samples;
  const ratio = to / from;
  const out = new Float32Array(Math.max(1, Math.floor(samples.length * ratio)));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const low = Math.floor(src);
    const high = Math.min(samples.length - 1, low + 1);
    const frac = src - low;
    out[i] = samples[low] * (1 - frac) + samples[high] * frac;
  }
  return out;
}

function toPcm16Base64(samples) {
  const bytes = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.round(clamped * 0x7fff), i * 2);
  }
  return bytes.toString("base64");
}

/** One utterance through the pipeline: returns its transcript, the tool call it made, and the gap. */
async function runSpeechCase(text) {
  const synth = spawnSync("voice-gen", ["speak", text, "--format", "wav", "--json"], { encoding: "utf8", timeout: 300_000 });
  if (synth.status !== 0) throw new Error(`voice-gen failed: ${(synth.stderr || synth.stdout || "").slice(0, 200)}`);
  let wavPath = "";
  try {
    const parsed = JSON.parse(synth.stdout.trim().split("\n").at(-1));
    wavPath = parsed.path ?? parsed.file ?? parsed.out ?? "";
  } catch { /* fall through to the glob below */ }
  if (!wavPath || !existsSync(wavPath)) throw new Error(`voice-gen produced no readable file (parsed "${wavPath}")`);

  const { samples, rate } = readWav(wavPath);
  const mono = resample(samples, rate);
  const frames = [];
  for (let i = 0; i < mono.length; i += 1600) frames.push(toPcm16Base64(mono.subarray(i, i + 1600)));
  // Trailing silence is what ends a turn: the server only counts samples, never wall clock.
  const silence = toPcm16Base64(new Float32Array(1600 * 3));
  for (let i = 0; i < 5; i++) frames.push(silence);

  const ws = new WebSocket(REALTIME, "realtime");
  const result = { transcript: "", toolQuestion: "", firstAudioMs: null, error: null };
  let lastFrameAt = 0;
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("realtime handshake timed out")), 15_000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          audio: { input: { turn_detection: { type: "server_vad", create_response: false } } },
          instructions: "Answer briefly in natural spoken Chinese, no markdown.",
        },
      }));
      clearTimeout(deadline);
      resolve();
    });
    ws.addEventListener("error", () => { clearTimeout(deadline); reject(new Error("realtime connect failed")); });
  });

  const finished = new Promise((resolve) => {    const timer = setTimeout(() => resolve(), 25_000);
    let dones = 0;
    ws.addEventListener("message", (raw) => {
      let event;
      try { event = JSON.parse(raw.data); } catch { return; }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        result.transcript = String(event.transcript ?? "");
        // The server will not generate on its own with `create_response: false` — the page's gate
        // asks after accepting a turn, and so does the harness, or nothing here is ever spoken.
        ws.send(JSON.stringify({ type: "response.create" }));
      }
      if (event.type === "response.function_call_arguments.done") {
        try { result.toolQuestion = String(JSON.parse(event.arguments ?? "{}").question ?? ""); } catch { /* not ask_pi */ }
        // Mirror `ask_pi`'s immediate answer, then ask again: the spoken reply to that is the
        // number the ADR wants (the panel does exactly this in `startPiJob`).
        ws.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify({ state: "started", question: result.toolQuestion }) },
        }));
        ws.send(JSON.stringify({ type: "response.create" }));
      }
      if (event.type === "response.output_audio.delta" && result.firstAudioMs === null && lastFrameAt) {
        result.firstAudioMs = Date.now() - lastFrameAt;
      }
      if (event.type === "response.done") {
        dones += 1;
        if (result.firstAudioMs !== null || dones >= 2) { clearTimeout(timer); resolve(); }
      }
    });
    void (async () => {
      for (const frame of frames) {
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: frame }));
        lastFrameAt = Date.now();
        await sleep(100); // pace like a live microphone: the server reads audio time, not arrival bursts
      }
    })().catch((error) => { result.error = String(error); clearTimeout(timer); resolve(); });
  });
  await finished;
  try { ws.close(); } catch { /* already gone */ }
  rmSync(wavPath, { force: true });
  return result;
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const rows = [];
  const created = await post("/api/agent/new", { cwd: CWD, type: "ensure_session" });
  const sessionId = created.sessionId;
  if (!sessionId) throw new Error(`/api/agent/new returned no sessionId: ${JSON.stringify(created).slice(0, 200)}`);
  const stream = openEventStream(sessionId);
  await sleep(1500);
  if (!stream.state.connected) stream.state.error = stream.state.error ?? "never connected";

  console.log(`pi-web ${BASE} · session ${sessionId} · ${LIMIT} asks${SPEECH ? " · speech leg on" : ""}`);
  const ledger = await ledgerSmoke(sessionId).catch((error) => ({ error: String(error) }));

  for (let index = 0; index < LIMIT; index++) {
    if (stream.state.error) {
      // Without the run-end events there is nothing to pair against, and posting anyway is how
      // the first run of this script turned one dead stream into a cascade of 500s.
      rows.push({ token: scriptedAsk(index).token, verdict: `stream-lost (${stream.state.error})`, paired: false, ms: 0, chars: 0 });
      continue;
    }
    const ask = scriptedAsk(index);
    const requestId = randomUUID();
    const began = Date.now();
    let verdict = "answered";
    let answer = "";
    let paired = false;
    try {
      const sent = await post(`/api/agent/${encodeURIComponent(sessionId)}`, { type: "prompt", message: ask.text, requestId });
      if (sent?.error) {
        verdict = `prompt-rejected: ${String(sent.error).slice(0, 60)}`;
      } else {
        const ended = await awaitRun(stream, requestId, ASK_TIMEOUT_MS);
        answer = await readNewestAnswer(sessionId);
        paired = answer.includes(ask.token);
        // Mis-pairing is the delivery failure ADR 0008 gates on: an answer that belongs to
        // *another* ask. A correct answer that merely did not repeat its token is a phrasing
        // miss ("unconfirmed") which the panel would still speak truthfully — counted, but it
        // does not consume the mis-pairing budget.
        const staleOf = earlierTokens(index).find((token) => !paired && answer.includes(token)) ?? null;
        if (!ended.ok) verdict = ended.reason === "timeout" ? "no-run-end-event" : "stream-lost";
        else if (!answer) verdict = "empty-answer";
        else if (staleOf) verdict = `mis-paired (answer of ${staleOf})`;
        else if (!paired) verdict = "unconfirmed";
      }
    } catch (error) {
      verdict = `error: ${String(error).slice(0, 80)}`;
    }
    rows.push({
      token: ask.token, verdict, paired, ms: Date.now() - began, chars: answer.length,
      answer: answer.slice(0, 60).replace(/\s+/g, " "),
    });
    console.log(`  ${ask.token} ${verdict.padEnd(24)} ${String(Date.now() - began).padStart(6)} ms`);
  }

  const speechRows = [];
  if (SPEECH) {
    for (const ask of rows.slice(0, Math.min(6, rows.length))) {
      try {
        const spoken = await runSpeechCase(`查一下 ${ask.token}`);
        speechRows.push({ token: ask.token, transcript: spoken.transcript, tool: spoken.toolQuestion, firstAudioMs: spoken.firstAudioMs, error: spoken.error });
        console.log(`  speech ${ask.token} first-audio ${spoken.firstAudioMs ?? "n/a"} ms · transcript "${(spoken.transcript || "").slice(0, 30)}"`);
      } catch (error) {
        speechRows.push({ token: ask.token, error: String(error).slice(0, 120) });
        console.log(`  speech ${ask.token} failed: ${String(error).slice(0, 120)}`);
      }
    }
  }
  stream.close();

  const answered = rows.filter((row) => row.paired).length;
  const misPaired = rows.filter((row) => row.verdict.startsWith("mis-paired")).length;
  const unconfirmed = rows.filter((row) => row.verdict === "unconfirmed").length;
  const rate = rows.length ? (misPaired / rows.length) * 100 : 100;
  const latencies = rows.map((row) => row.ms).sort((a, b) => a - b);
  const percentile = (p) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)] : 0);
  const speechLatencies = speechRows.map((row) => row.firstAudioMs).filter((value) => typeof value === "number").sort((a, b) => a - b);
  const speechPercentile = (p) => (speechLatencies.length ? speechLatencies[Math.min(speechLatencies.length - 1, Math.ceil((p / 100) * speechLatencies.length) - 1)] : null);

  const report = [
    "# 语音送达回归",
    "",
    `- server: \`${BASE}\` · session \`${sessionId}\` · ${new Date().toISOString()}`,
    `- asks: ${rows.length} · 配对正确 ${answered} · 错配 ${misPaired} (${rate.toFixed(1)} %) · 门槛 < 5 % · 未复述编号 ${unconfirmed}`,
    `- pi 侧每问耗时: P50 ${percentile(50)} ms · P90 ${percentile(90)} ms · 最长 ${latencies.at(-1) ?? 0} ms`,
    `- ledger: ${JSON.stringify(ledger)}`,
    SPEECH ? `- 说完→首个音频帧 (合成语音, n=${speechLatencies.length}): P50 ${speechPercentile(50) ?? "n/a"} ms · P90 ${speechPercentile(90) ?? "n/a"} ms` : "- speech leg: off (--speech)",
    "",
    "| token | 判定 | 配对 | 用时 | 答案开头 |",
    "|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.token} | ${row.verdict} | ${row.paired ? "✓" : "✗"} | ${row.ms} ms | ${(row.answer ?? "").replace(/\|/g, "\\|").slice(0, 40)} |`),
    ...(speechRows.length ? ["", "| token | 转写 | ask_pi 里的问题 | 首音 |", "|---|---|---|---|",
      ...speechRows.map((row) => `| ${row.token} | ${(row.transcript ?? row.error ?? "").replace(/\|/g, "\\|").slice(0, 40)} | ${(row.tool ?? "").replace(/\|/g, "\\|").slice(0, 40)} | ${row.firstAudioMs ?? "—"} |`)] : []),
    "",
    "**未覆盖**：误唤醒率与真实噪声（合成语音测不到，按 ADR 用一周真实日志统计）、浏览器面板的实际播报（脚本走的是服务端契约与账本接口）。",
    "",
  ].join("\n");

  if (REPORT) {
    mkdirSync(REPORT.replace(/[^/]*$/, ""), { recursive: true });
    writeFileSync(REPORT, report);
    console.log(`\nreport → ${REPORT}`);
  } else {
    console.log(`\n${report}`);
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (rate >= 5) {
    console.error(`FAIL: mis-pairing ${rate.toFixed(1)} % is at or above the 5 % gate`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`voice-delivery failed: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
