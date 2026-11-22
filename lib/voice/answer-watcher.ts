// One short-lived look at a session's agent event stream, for a caller that needs to know when
// *its own* run ended.
//
// The voice bridge used to guess that from the outside: poll until pi looked idle, then read the
// newest assistant text and hope it was the answer to the question it had asked. ADR 0008 replaced
// the guess with an identity — the caller submits a `requestId` and the wrapper echoes it back on
// `user_message_entry` (the message that started the run) and on `prompt_done` / `prompt_error`
// (that run's end). This module is the read side of that handshake.
//
// It deliberately opens its own stream rather than borrowing the page's: the page keeps one stream
// alive for the whole session, while a voice job needs one for seconds at a time and must not
// couple the composer's event handling to the call. Nothing here decides what happens when no
// event arrives: the caller keeps its polling fallback, so a stalled or refused stream costs delay,
// never an answer.

import type { AgentEventLike } from "../agent-event-wire";

/** Resolved shape of a wait: the run ended, or this watcher learned nothing and the caller polls. */
export type RunEndResult =
  | { ended: true; aborted?: boolean; anchorEntryId?: string }
  | { ended: false };

export interface RunEndWatcher {
  /**
   * Resolve when pi ends the run that `requestId` started, or with `{ended:false}` after
   * `timeoutMs` — including when the stream never opened or dropped. Never rejects: a delivery
   * watcher that cannot see is an ordinary delay, not an error the user should hear about.
   */
  whenRunEnds(sessionId: string, requestId: string, timeoutMs: number): Promise<RunEndResult>;
  /** Abandon every wait and close the streams. */
  close(): void;
}

/** The slice of `EventSource` this module touches, so a test can hand in a fake. */
export interface WatchSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface RunEndWatcherOptions {
  /** Defaults to a browser `EventSource` on the page's own origin. */
  createSource?(url: string): WatchSourceLike;
  /** What the route is called with: `/api/agent/<id>/events` by default. */
  streamUrl?(sessionId: string): string;
  /** How long a stream may stay silent before its waits are written off. Tests shorten it. */
  streamDeadMs?: number;
}

/**
 * How long a fresh stream may stay silent before its waits are written off. A working stream
 * publishes a snapshot at once and a heartbeat every `AGENT_EVENT_HEARTBEAT_MS`, so silence here
 * means the connection never really opened — and the caller's poll should start long before an
 * answer-sized wait has burned up.
 */
const STREAM_DEAD_MS = 10_000;

interface Waiter {
  requestId: string;
  settle(result: RunEndResult): void;
  timer: ReturnType<typeof setTimeout>;
  anchorEntryId?: string;
}

interface Stream {
  source: WatchSourceLike;
  waiters: Set<Waiter>;
  closed: boolean;
  /** Anything at all has arrived on this stream. */
  sawData: boolean;
  deadTimer: ReturnType<typeof setTimeout> | null;
}

function defaultStreamUrl(sessionId: string): string {
  return `/api/agent/${encodeURIComponent(sessionId)}/events`;
}

function createEventSource(url: string): WatchSourceLike {
  // SAFETY: the browser's EventSource exposes exactly the three members WatchSourceLike names —
  // onmessage, onerror, close — and this module reads nothing else off it, so the structural cast
  // cannot miss a method the watcher would call.
  return new EventSource(url) as unknown as WatchSourceLike;
}

/**
 * Watch a session's agent events for the end of the runs this caller started. Waits for different
 * sessions share one stream; the stream closes when the last one settles.
 */
export function createRunEndWatcher(opts: RunEndWatcherOptions = {}): RunEndWatcher {
  const makeSource = opts.createSource ?? createEventSource;
  const streamUrl = opts.streamUrl ?? defaultStreamUrl;
  const streamDeadMs = opts.streamDeadMs ?? STREAM_DEAD_MS;
  const streams = new Map<string, Stream>();

  function release(sessionId: string, stream: Stream): void {
    if (stream.closed) return;
    stream.closed = true;
    if (stream.deadTimer !== null) clearTimeout(stream.deadTimer);
    try {
      stream.source.close();
    } catch { /* already gone */ }
    if (streams.get(sessionId) === stream) streams.delete(sessionId);
  }

  /** A stream that never delivered: give its waits up so every caller falls back to polling. */
  function failStream(sessionId: string, stream: Stream): void {
    for (const waiter of [...stream.waiters]) {
      stream.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.settle({ ended: false });
    }
    release(sessionId, stream);
  }

  function join(sessionId: string): Stream | null {
    const existing = streams.get(sessionId);
    if (existing) return existing;
    let source: WatchSourceLike;
    try {
      source = makeSource(streamUrl(sessionId));
    } catch {
      return null;
    }
    const stream: Stream = { source, waiters: new Set(), closed: false, sawData: false, deadTimer: null };
    streams.set(sessionId, stream);
    stream.deadTimer = setTimeout(() => {
      if (!stream.sawData) failStream(sessionId, stream);
    }, streamDeadMs);
    source.onmessage = (event) => {
      stream.sawData = true;
      let parsed: AgentEventLike;
      try {
        parsed = JSON.parse(String(event.data)) as AgentEventLike;
      } catch {
        return;
      }
      for (const waiter of [...stream.waiters]) {
        if (parsed.type === "user_message_entry" && parsed.requestId === waiter.requestId) {
          if (typeof parsed.entryId === "string") waiter.anchorEntryId = parsed.entryId;
          continue;
        }
        const terminal = (parsed.type === "prompt_done" || parsed.type === "prompt_error")
          && parsed.requestId === waiter.requestId;
        if (!terminal) continue;
        stream.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.settle({
          ended: true,
          ...(parsed.type === "prompt_done" && parsed.aborted === true ? { aborted: true } : {}),
          ...(waiter.anchorEntryId ? { anchorEntryId: waiter.anchorEntryId } : {}),
        });
      }
      if (stream.waiters.size === 0) release(sessionId, stream);
    };
    // A refused or dropped stream is not worth an error path of its own: each waiter already has
    // a timer, and a stream that never delivered is failed above, so the caller polls exactly as
    // it did before the handshake existed.
    source.onerror = () => { /* the timers decide */ };
    return stream;
  }

  return {
    whenRunEnds(sessionId, requestId, timeoutMs) {
      return new Promise<RunEndResult>((resolve) => {
        const stream = join(sessionId);
        if (!stream) {
          resolve({ ended: false });
          return;
        }
        const waiter: Waiter = {
          requestId,
          settle: resolve,
          timer: setTimeout(() => {
            stream.waiters.delete(waiter);
            resolve({ ended: false });
            if (stream.waiters.size === 0) release(sessionId, stream);
          }, timeoutMs),
        };
        stream.waiters.add(waiter);
      });
    },
    close() {
      for (const [sessionId, stream] of [...streams]) {
        for (const waiter of stream.waiters) {
          clearTimeout(waiter.timer);
          waiter.settle({ ended: false });
        }
        stream.waiters.clear();
        release(sessionId, stream);
      }
      streams.clear();
    },
  };
}
