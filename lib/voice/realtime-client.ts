// A minimal OpenAI Realtime WebSocket client for voice sessions: dictation
// (input-only, auto-cancels the assistant reply) and conversation (keeps the
// reply's audio, transcripts and tool calls).
//
// The speech-to-speech server (https://github.com/huggingface/speech-to-speech)
// drives turns with its own VAD: it emits transcription events per utterance,
// then auto-generates an assistant response. A dictation client does not want
// the response, so `cancelResponses` answers every `response.created` with
// `response.cancel` — the server keeps no assistant history for a cancelled
// reply whose audio never started.

export interface DictationError {
  code: string;
  message: string;
}

export interface DictationHandlers {
  /**
   * Authoritative final transcript for one VAD utterance. `accepted` is the
   * caller's own verdict from `acceptTurn`: a rejected turn still reaches the
   * transcript, it just never gets an answer.
   */
  onSegment: (transcript: string, info: { seconds: number; accepted: boolean }) => void;
  /** In-progress hypothesis across all not-yet-final items (display only). */
  onPartial: (transcript: string) => void;
  /**
   * Swallow a turn the user did not say — a voice from another room, one
   * interjection. Returning false skips the reply this client would ask for.
   * `seconds` is the turn's audio length, 0 when the server does not report it.
   */
  acceptTurn?: (transcript: string, seconds: number) => boolean;
  onError?: (error: DictationError) => void;
  /** The user started talking: a conversation client flushes its player. */
  onSpeechStarted?: () => void;
  /** Assistant reply audio (base64 PCM16 at the pipeline rate). */
  onAudioChunk?: (base64Pcm16: string) => void;
  /** Incremental assistant transcript text. */
  onAssistantDelta?: (text: string) => void;
  /** The model called a tool declared in `tools`. */
  onFunctionCall?: (call: { callId: string; name: string; argumentsJson: string }) => void;
  /** A response opened: the voice layer is about to speak. */
  onResponseStarted?: () => void;
  /** A response closed: completed | cancelled | failed | incomplete. */
  onResponseDone?: (status: string) => void;
  /**
   * The socket ended on its own: the code and reason the server closed with, and whether this
   * client ever got a session. A dropped call used to leave the screen exactly as it was — the
   * pill still green, the microphone still claimed — which is how a dead call gets experienced as
   * "it stopped listening" (ADR 0008 #7).
   */
  onConnectionEnded?: (info: { code: number; reason: string; everConnected: boolean }) => void;
  /**
   * A queued announcement was actually handed to the model — the moment it stops being owed.
   * `tag` is whatever the caller attached to it; the voice layer passes its ledger entry id, so a
   * replayed answer is marked read when it is spoken and stays unread across a hang-up.
   */
  onNoticeInjected?: (tag: string) => void;
}

export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
}

export type WsCtor = new (url: string) => WsLike;

export interface RealtimeClientOptions {
  cancelResponses?: boolean;
  WebSocketImpl?: WsCtor;
  connectTimeoutMs?: number;
  /** Function tools for `session.update` (conversation mode). */
  tools?: unknown[];
  instructions?: string;
  /**
   * Take over turn-taking: the server's VAD stops answering by itself
   * (`turn_detection.create_response: false`) and this client asks for a reply
   * only when the way is clear. The speech-to-speech server refuses a response
   * request that lands while another is open, or while a function call still
   * owes it an output (`function_call_output_pending`) — which is what a call
   * that goes silent in the middle of a tool run looks like.
   */
  gateResponses?: boolean;
  /**
   * How long a `response.create` may wait for its `response.created` before it is counted as
   * lost. Omitted: `CREATE_ACK_TIMEOUT_MS`.
   */
  createAckTimeoutMs?: number;
}

const SILENCE_CHUNK_B64 = "AA".repeat(3200); // 100 ms of 16 kHz mono PCM16

/**
 * Marks an injected message as something the user did not say, so the voice
 * layer tells it apart from its own transcript: a job that finished long after
 * it was started arrives as a background event instead of a waiting tool call.
 */
export const BACKGROUND_EVENT_PREFIX = "[background event, not said by the user]";

/** A `response.create` the server refused: it stays owed and is retried. */
const RETRYABLE_CREATE_ERRORS = new Set([
  "function_call_output_pending",
  "conversation_already_has_active_response",
]);

/**
 * A `response.create` the server neither opens nor refuses. The two refusal codes the client
 * knows about are handled where they arrive, but an unknown code — or a socket that is half
 * gone — used to leave `createOpen` true forever, parking every later announcement behind a
 * reply that was never coming. A timeout turns that deadlock into a retry (ADR 0008 #11).
 */
const CREATE_ACK_TIMEOUT_MS = 8_000;
/** Consecutive lost creates before the call is declared stalled instead of retried forever. */
const CREATE_STALL_LIMIT = 3;

export function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export class RealtimeDictationClient {
  private readonly urls: string[];
  private readonly handlers: DictationHandlers;
  private readonly opts: RealtimeClientOptions;
  private ws: WsLike | null = null;
  private readonly pending = new Map<string, string>();
  private readonly finalized = new Set<string>();
  private lastKey = "";
  private readonly gate: boolean;
  /** A response is generating, or its audio is being sent. */
  private inResponse = false;
  /** We asked for a response and the server has not opened one yet. */
  private createOpen = false;
  /** Tool calls the model made that we still owe an output for. */
  private readonly openCalls = new Set<string>();
  /** A reply is due as soon as the way clears. */
  private owed = false;
  /** Whether this client ever reached a session, so a close can be told between refused and dropped. */
  private everConnected = false;
  /** The socket ended, and the reason was reported. One report per client. */
  private endedReported = false;
  /** The app hung up: a close we asked for is not a lost call. */
  private closingSocket = false;
  /** Waiting for the sentence in flight to end (see `flushSpeakingTurn`). */
  private readonly speakingWaiters: Array<() => void> = [];
  /** The `response.create` that has not been acknowledged, and how many in a row went unanswered. */
  private createTimer: ReturnType<typeof setTimeout> | null = null;
  private createStalls = 0;
  /** Out-of-band announcements to speak, oldest first, each with the tag its caller asked back. */
  private readonly notices: { text: string; tag: string }[] = [];
  /** The user is mid-sentence: hold an announcement until they finish. */
  private speaking = false;

  constructor(urls: string[], handlers: DictationHandlers, opts: RealtimeClientOptions = {}) {
    this.urls = urls;
    this.handlers = handlers;
    this.opts = opts;
    this.gate = opts.gateResponses === true;
  }

  get connected(): boolean {
    return this.ws !== null;
  }

  /** Try each candidate URL in order; resolves with the one that opened. */
  connect(): Promise<string> {
    // SAFETY: the global WebSocket constructor yields an object whose legacy
    // on* handler properties, send() and close() match WsLike exactly.
    const Impl: WsCtor | null = this.opts.WebSocketImpl
      ?? (globalThis as { WebSocket?: WsCtor }).WebSocket
      ?? null;
    if (!Impl) return Promise.reject(new Error("WebSocket is unavailable"));
    const timeoutMs = this.opts.connectTimeoutMs ?? 4000;
    let lastFailure: unknown = new Error("no candidates");
    return this.urls.reduce(
      (chain: Promise<string>, url) => chain.catch(() => new Promise<string>((resolve, reject) => {
        let ws: WsLike;
        try {
          ws = new Impl(url);
        } catch (error) {
          reject(error);
          return;
        }
        lastFailure = new Error(`could not reach ${url}`);
        const timer = setTimeout(() => {
          try { ws.close(); } catch { /* already gone */ }
          reject(lastFailure);
        }, timeoutMs);
        const settleFail = () => { clearTimeout(timer); try { ws.close(); } catch { /* ignore */ } reject(lastFailure); };
        ws.onerror = settleFail;
        ws.onclose = settleFail;
        ws.onmessage = (event) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(String(event.data)) as Record<string, unknown>;
          } catch {
            return;
          }
          if (msg.type === "session.created") {
            clearTimeout(timer);
            this.ws = ws;
            this.everConnected = true;
            ws.onerror = () => { this.ws = null; try { ws.close(); } catch { /* gone */ } this.handlers.onError?.({ code: "connection_error", message: "voice server connection lost" }); };
            ws.onclose = (event) => { this.ws = null; this.reportEnded(event); };
            ws.onmessage = (ev) => this.route(ev);
            ws.send(JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                audio: {
                  input: {
                    turn_detection: {
                      type: "server_vad",
                      ...(this.gate ? { create_response: false } : {}),
                    },
                  },
                },
                extensions: ["speech_to_speech.input_audio_transcription.snapshot"],
                ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
                ...(this.opts.tools?.length ? { tools: this.opts.tools } : {}),
              },
            }));
            resolve(url);
          } else {
            this.route({ data: event.data });
          }
        };
      })),
      Promise.reject(lastFailure) as Promise<string>,
    );
  }

  sendEvent(event: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(event));
  }

  /** Deliver a tool result; `createResponse` also asks the model to speak it. */
  sendFunctionOutput(callId: string, output: string, createResponse = true): void {
    this.openCalls.delete(callId);
    this.sendEvent({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    if (createResponse) this.requestReply();
  }

  /** Ask the voice layer for a spoken reply to what the conversation holds. */
  requestReply(): void {
    if (!this.gate) {
      this.sendEvent({ type: "response.create" });
      return;
    }
    this.owed = true;
    this.replyWhenClear();
  }

  /**
   * Queue an announcement of work that finished on its own — pi's answer
   * minutes after the tool call that started it — so the conversation stays
   * open while the work runs, and is told about it when the user next stops.
   */
  notify(text: string, tag = ""): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.gate) {
      this.injectNotice(trimmed, tag);
      this.requestReply();
      return;
    }
    this.notices.push({ text: trimmed, tag });
    this.replyWhenClear();
  }

  /** Forget queued announcements the user cancelled. */
  dropNotifications(): void {
    this.notices.length = 0;
  }

  private injectNotice(text: string, tag: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${BACKGROUND_EVENT_PREFIX} ${text}` }],
      },
    });
    this.handlers.onNoticeInjected?.(tag);
  }

  /** Send the next owed reply, but only where a response can be created. */
  private replyWhenClear(): void {
    if (this.inResponse || this.createOpen || this.openCalls.size > 0) return;
    const notice = this.notices[0];
    if (notice !== undefined && this.speaking) return;
    if (notice === undefined && !this.owed) return;
    if (notice !== undefined) {
      this.notices.shift();
      this.injectNotice(notice.text, notice.tag);
    }
    // One reply covers the announcement and anything the user said around it.
    this.owed = false;
    this.createOpen = true;
    this.sendEvent({ type: "response.create" });
    this.armCreateTimer();
  }

  sendAudio(base64Pcm16: string): void {
    this.ws?.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Pcm16 }));
  }

  /** Flush a trailing utterance: the server VAD commits on the silence. */
  sendSilenceChunks(count = 5): void {
    for (let i = 0; i < count; i++) this.sendAudio(SILENCE_CHUNK_B64);
  }

  /**
   * Give the sentence the user is mid-way through a chance to finish before the microphone is
   * released. The server decides turn boundaries from the audio clock alone — it has no timer for
   * "the client stopped sending" — so releasing capture mid-sentence would strand that utterance
   * uncommitted *and* leave `speaking` true forever, which parks every later announcement behind a
   * sentence nobody is speaking any more (ADR 0008 #8).
   *
   * Returns whether the sentence landed. When it did not, the dangling transcript is dropped: a
   * half-word the user abandoned must not reappear in the caption of the next call.
   */
  async flushSpeakingTurn(timeoutMs = 300): Promise<boolean> {
    if (!this.ws) return true;
    const settled = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.speakingWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
    // Three 100 ms frames clears the server's 300 ms minimum silence, which is what ends a turn.
    this.sendSilenceChunks(3);
    const landed = await settled;
    if (!landed) this.discardSpeakingTurn();
    return landed;
  }

  /** Stop waiting on a sentence that is not going to commit, and forget its partial text. */
  private discardSpeakingTurn(): void {
    this.speaking = false;
    this.pending.clear();
    this.lastKey = "";
    this.emitPartial();
    this.releaseSpeakingWaiters();
  }

  private releaseSpeakingWaiters(): void {
    const waiters = this.speakingWaiters.splice(0);
    for (const release of waiters) release();
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    // A hang-up is not an outage: the close it causes must not report a lost call.
    this.closingSocket = true;
    this.releaseSpeakingWaiters();
    this.clearCreateTimer();
    try { ws?.close(); } catch { /* already closed */ }
  }

  private armCreateTimer(): void {
    this.clearCreateTimer();
    this.createTimer = setTimeout(() => this.onCreateStalled(), this.opts.createAckTimeoutMs ?? CREATE_ACK_TIMEOUT_MS);
  }

  private clearCreateTimer(): void {
    if (this.createTimer !== null) {
      clearTimeout(this.createTimer);
      this.createTimer = null;
    }
  }

  /** A create nobody answered: put the reply back on the books, and try again when the way clears. */
  private onCreateStalled(): void {
    this.createTimer = null;
    if (!this.createOpen) return;
    this.createOpen = false;
    this.owed = true;
    this.createStalls += 1;
    if (this.createStalls >= CREATE_STALL_LIMIT) {
      // Three lost creates in a row is not a race: the server stopped answering. Say so, instead
      // of a call that looks live and is only deaf (the review's 假在线).
      this.handlers.onError?.({ code: "connection_stalled", message: "voice server stopped answering" });
      return;
    }
    this.replyWhenClear();
  }

  /** Report the end of the socket once, with whatever the server bothered to say. */
  private reportEnded(event?: { code?: number; reason?: string }): void {
    if (this.endedReported || this.closingSocket) return;
    this.endedReported = true;
    this.handlers.onConnectionEnded?.({
      code: Number(event?.code ?? 0),
      reason: typeof event?.reason === "string" ? event.reason : "",
      everConnected: this.everConnected,
    });
  }

  private route(event: { data: unknown }): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case "conversation.item.input_audio_transcription.delta":
      case "conversation.item.input_audio_transcription.text": {
        const key = String(msg.item_id ?? this.lastKey ?? "") || "_anon";
        this.lastKey = key;
        const add = String(msg.text ?? msg.delta ?? "");
        this.pending.set(key, (this.pending.get(key) ?? "") + add);
        this.emitPartial();
        return;
      }
      case "speech_to_speech.input_audio_transcription.snapshot": {
        const key = String(msg.item_id ?? this.lastKey ?? "") || "_anon";
        this.lastKey = key;
        const text = msg.transcript ?? msg.text;
        if (typeof text === "string") this.pending.set(key, text);
        this.emitPartial();
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const key = String(msg.item_id ?? "") || this.lastKey || "_anon";
        const transcript = typeof msg.transcript === "string" ? msg.transcript : (this.pending.get(key) ?? "");
        const settled = !this.finalized.has(key) && transcript.trim().length > 0;
        const seconds = Number((msg.usage as { seconds?: unknown } | null)?.seconds);
        const accepted = settled && (this.handlers.acceptTurn?.(transcript.trim(), Number.isFinite(seconds) ? seconds : 0) ?? true);
        if (settled) this.handlers.onSegment(transcript.trim(), { seconds: Number.isFinite(seconds) ? seconds : 0, accepted });
        this.finalized.add(key);
        this.pending.delete(key);
        if (key === this.lastKey) this.lastKey = "";
        this.emitPartial();
        // Only a gated client drives generation, and only for turns it accepts;
        // dictation lets the server answer on its own and cancels what it answers.
        if (accepted && this.gate) this.requestReply();
        return;
      }
      case "input_audio_buffer.speech_started": {
        this.speaking = true;
        this.handlers.onSpeechStarted?.();
        return;
      }
      case "input_audio_buffer.speech_stopped":
      // A committed turn ends the sentence even if its soft-end was never sent:
      // an announcement must not sit behind a stuck `speaking` flag.
      case "input_audio_buffer.committed": {
        this.speaking = false;
        this.releaseSpeakingWaiters();
        this.replyWhenClear();
        return;
      }
      case "response.created": {
        this.inResponse = true;
        this.createOpen = false;
        this.clearCreateTimer();
        this.createStalls = 0;
        this.handlers.onResponseStarted?.();
        // Dictation does not want the assistant's reply: cancel it as soon as
        // it opens so no audio is synthesized and no history is kept.
        if (this.opts.cancelResponses !== false) this.ws?.send(JSON.stringify({ type: "response.cancel" }));
        return;
      }
      case "response.output_audio.delta": {
        const chunk = msg.delta;
        // A cancelled reply keeps streaming its already-synthesized audio; the
        // player was flushed when the user interrupted, so drop it here too.
        if (typeof chunk === "string" && this.inResponse) this.handlers.onAudioChunk?.(chunk);
        return;
      }
      case "response.output_audio_transcript.delta": {
        const chunk = msg.delta;
        if (typeof chunk === "string" && this.inResponse) this.handlers.onAssistantDelta?.(chunk);
        return;
      }
      case "response.function_call_arguments.done": {
        const callId = String(msg.call_id ?? "");
        if (callId) this.openCalls.add(callId);
        this.handlers.onFunctionCall?.({
          callId,
          name: String(msg.name ?? ""),
          argumentsJson: String(msg.arguments ?? "{}"),
        });
        return;
      }
      case "response.done": {
        this.inResponse = false;
        this.createOpen = false;
        this.clearCreateTimer();
        const response = (msg.response ?? {}) as Record<string, unknown>;
        this.handlers.onResponseDone?.(String(response.status ?? "completed"));
        this.replyWhenClear();
        return;
      }
      case "error": {
        const err = (msg.error ?? {}) as Record<string, unknown>;
        const code = String(err.code ?? err.type ?? "unknown");
        if (RETRYABLE_CREATE_ERRORS.has(code) && this.createOpen) {
          // Nothing opened, so the reply is still owed: retry once the reason
          // for the refusal is gone.
          this.createOpen = false;
          this.clearCreateTimer();
          this.owed = true;
        }
        if (code === "session_limit_reached") {
          this.handlers.onError?.({ code, message: "voice server busy" });
        } else {
          this.handlers.onError?.({ code, message: String(err.message ?? "voice server error") });
        }
        return;
      }
      default:
    }
  }

  private emitPartial(): void {
    let text = "";
    for (const value of this.pending.values()) text += value;
    this.handlers.onPartial(text);
  }
}
