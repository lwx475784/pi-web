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
  /** Authoritative final transcript for one VAD utterance. */
  onSegment: (transcript: string) => void;
  /** In-progress hypothesis across all not-yet-final items (display only). */
  onPartial: (transcript: string) => void;
  onError?: (error: DictationError) => void;
  /** The user started talking: a conversation client flushes its player. */
  onSpeechStarted?: () => void;
  /** Assistant reply audio (base64 PCM16 at the pipeline rate). */
  onAudioChunk?: (base64Pcm16: string) => void;
  /** Incremental assistant transcript text. */
  onAssistantDelta?: (text: string) => void;
  /** The model called a tool declared in `tools`. */
  onFunctionCall?: (call: { callId: string; name: string; argumentsJson: string }) => void;
  /** A response closed: completed | cancelled | failed | incomplete. */
  onResponseDone?: (status: string) => void;
}

export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export type WsCtor = new (url: string) => WsLike;

export interface RealtimeClientOptions {
  cancelResponses?: boolean;
  WebSocketImpl?: WsCtor;
  connectTimeoutMs?: number;
  /** Function tools for `session.update` (conversation mode). */
  tools?: unknown[];
  instructions?: string;
}

const SILENCE_CHUNK_B64 = "AA".repeat(3200); // 100 ms of 16 kHz mono PCM16

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

  constructor(urls: string[], handlers: DictationHandlers, opts: RealtimeClientOptions = {}) {
    this.urls = urls;
    this.handlers = handlers;
    this.opts = opts;
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
            ws.onerror = () => { this.ws = null; try { ws.close(); } catch { /* gone */ } this.handlers.onError?.({ code: "connection_error", message: "voice server connection lost" }); };
            ws.onclose = () => { this.ws = null; };
            ws.onmessage = (ev) => this.route(ev);
            ws.send(JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime",
                audio: { input: { turn_detection: { type: "server_vad" } } },
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
    this.sendEvent({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    });
    if (createResponse) this.sendEvent({ type: "response.create" });
  }

  sendAudio(base64Pcm16: string): void {
    this.ws?.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Pcm16 }));
  }

  /** Flush a trailing utterance: the server VAD commits on the silence. */
  sendSilenceChunks(count = 5): void {
    for (let i = 0; i < count; i++) this.sendAudio(SILENCE_CHUNK_B64);
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already closed */ }
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
        if (!this.finalized.has(key) && transcript.trim()) this.handlers.onSegment(transcript.trim());
        this.finalized.add(key);
        this.pending.delete(key);
        if (key === this.lastKey) this.lastKey = "";
        this.emitPartial();
        return;
      }
      case "input_audio_buffer.speech_started": {
        this.handlers.onSpeechStarted?.();
        return;
      }
      case "response.created": {
        // Dictation does not want the assistant's reply: cancel it as soon as
        // it opens so no audio is synthesized and no history is kept.
        if (this.opts.cancelResponses !== false) this.ws?.send(JSON.stringify({ type: "response.cancel" }));
        return;
      }
      case "response.output_audio.delta": {
        const chunk = msg.delta;
        if (typeof chunk === "string") this.handlers.onAudioChunk?.(chunk);
        return;
      }
      case "response.output_audio_transcript.delta": {
        const chunk = msg.delta;
        if (typeof chunk === "string") this.handlers.onAssistantDelta?.(chunk);
        return;
      }
      case "response.function_call_arguments.done": {
        this.handlers.onFunctionCall?.({
          callId: String(msg.call_id ?? ""),
          name: String(msg.name ?? ""),
          argumentsJson: String(msg.arguments ?? "{}"),
        });
        return;
      }
      case "response.done": {
        const response = (msg.response ?? {}) as Record<string, unknown>;
        this.handlers.onResponseDone?.(String(response.status ?? "completed"));
        return;
      }
      case "error": {
        const err = (msg.error ?? {}) as Record<string, unknown>;
        const code = String(err.code ?? err.type ?? "unknown");
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
