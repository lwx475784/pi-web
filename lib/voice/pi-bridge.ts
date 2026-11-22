// The two-layer bridge: the voice layer asks this to run a real pi turn in the
// current session and returns pi's final answer text. It deliberately reuses
// the page's own REST surface (POST a prompt, read the context tail), so the call
// never touches pi internals, and it prefers pi's own run-end event over guessing
// when the answer is ready (ADR 0008).

import type { RunEndResult, RunEndWatcher } from "./answer-watcher";

export interface AskPiOptions {
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Stop waiting when the user cancels; `stopPiRun` stops pi itself. */
  signal?: AbortSignal;
  /**
   * Watches for the end of the run this call's `requestId` started. Absent — or when the caller
   * left the setting for it switched off — the bridge polls and infers, which is the old path.
   */
  watcher?: RunEndWatcher;
  /** Correlation id for the submission; a UUID by default, injectable so a test can pin it. */
  requestIdFactory?: () => string;
}

/** Thrown when the caller cancelled: a stale answer must not be announced. */
export class PiRequestCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "PiRequestCancelled";
  }
}

/** True for a rejection caused by an `AskPiOptions.signal` abort. */
export function isPiRequestCancelled(error: unknown): boolean {
  return error instanceof PiRequestCancelled
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

/**
 * The transcript a context page carries. `GET /api/sessions/[id]/context` answers
 * `{ context: { messages, entryIds, … } }`; a bare list of entries, and entries
 * wrapped in `{ message }`, are read the same way.
 */
export function contextEntries(context: unknown): unknown[] {
  if (Array.isArray(context)) return context;
  if (context && typeof context === "object") {
    const messages = (context as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return messages;
  }
  return [];
}

/** Newest assistant message text in a session-context page, or "". */
export function lastAssistantText(context: unknown): string {
  const entries = contextEntries(context);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object") continue;
    const message = ("message" in entry && entry.message ? entry.message : entry) as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
        .map((block) => String((block as { text?: string }).text ?? ""))
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

/** All requests go to this page's own same-origin API; nothing external. */
function localApiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!input.startsWith("/api/")) throw new Error(`unexpected path: ${input}`);
  // Rebuild against the page origin and assert it: no host can leak in.
  const url = new URL(input, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error(`unexpected origin: ${url.origin}`);
  const requestPageApi = globalThis.fetch;
  return requestPageApi(url.href, init); // path allowlist + origin assertion above
}

/**
 * How long a voice job keeps waiting for pi's answer.
 *
 * `ask_pi` answers the voice layer at once, so this wait costs no turn: it only
 * decides when a finished answer stops being announced. A voice ask fans out
 * into a real agent run — tool calls, subagents, a long reply. The first one
 * measured 219 s end to end, so anything near three minutes throws the answer
 * away and announces a failure for a run that answered moments later. This cap
 * is a guard for a wedged run, not a budget for a normal one.
 */
const ANSWER_WAIT_MS = 20 * 60_000;

/**
 * How long the poll keeps trying after pi's run-end event failed to arrive. The event is the
 * answer's identity; a missing one is a wire or stream problem, and the poll can still find the
 * text — but it should stop soon rather than double an already long wait.
 */
const POLL_AFTER_EVENT_MS = 30_000;

function newRequestId(): string {
  const uuid = (globalThis.crypto as Crypto | undefined)?.randomUUID?.();
  return uuid ?? `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A correlation id for one submission: opaque, bounded, and minted by the voice layer. */
export function createRequestId(): string {
  return newRequestId();
}

/**
 * Send `question` as a pi prompt to `sessionId` and return pi's answer to it.
 *
 * The submission carries a `requestId`; when a `watcher` is given, the run that id started is
 * awaited by name and the transcript is read once its end is announced. Without one — or when the
 * event never arrives — the bridge falls back to polling until pi looks idle with new output.
 * Rejects only when pi produced nothing inside `timeoutMs` (a wedged run), or when `signal` aborts.
 */
export async function askPiReply(sessionId: string, question: string, opts: AskPiOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? ANSWER_WAIT_MS;
  const pollMs = opts.pollMs ?? 1200;
  const call = opts.fetchImpl ?? localApiFetch;
  const enc = encodeURIComponent(sessionId);
  const contextUrl = `/api/sessions/${enc}/context?tail=8`;
  const requestId = (opts.requestIdFactory ?? newRequestId)();
  const aborted = () => opts.signal?.aborted === true;

  let beforeLeaf = "";
  try {
    const r = await call(contextUrl, opts.signal ? { signal: opts.signal } : undefined);
    if (r.ok) beforeLeaf = String(((await r.json()) as { leafId?: unknown }).leafId ?? "");
  } catch { /* best-effort baseline */ }
  if (aborted()) throw new PiRequestCancelled();

  const post = (body: Record<string, unknown>) => call(`/api/agent/${enc}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  let res = await post({ type: "prompt", message: question, requestId });
  if (aborted()) throw new PiRequestCancelled();
  let sent = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  // Whether this submission joined a run somebody else started. Such a message gets no run
  // identity back (pi only names the run its own prompt started), so the event handshake cannot
  // see its end and the poll has to.
  let joinedAnotherRun = false;
  if (!res.ok || sent.error) {
    if (sent.code !== "prompt_rejected") throw new Error(sent.error ?? `pi send failed (HTTP ${res.status})`);
    // pi is mid-run. Its SDK refuses a bare prompt while a run streams ("Agent is already
    // processing. Specify streamingBehavior ('steer' or 'followUp')"), but a follow-up joins
    // that run's queue and answers on its next turn — what the composer does with a message typed
    // during a run. Queue it; do not tell the user busy. A queued answer carries no request
    // identity, so the watcher cannot see its end and the poll below does the work.
    res = await post({ type: "prompt", message: question, requestId, streamingBehavior: "followUp" });
    if (aborted()) throw new PiRequestCancelled();
    sent = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (!res.ok || sent.error) throw new Error("pi is busy");
    joinedAnotherRun = true;
  }

  if (opts.watcher && !joinedAnotherRun) {
    const ended = await waitRunEnd(opts.watcher, sessionId, requestId, timeoutMs, opts.signal);
    if (aborted()) throw new PiRequestCancelled();
    if (ended.ended) {
      const answer = await readAnswer(call, contextUrl, beforeLeaf);
      if (answer) return answer;
    }
    return pollForAnswer(call, contextUrl, beforeLeaf, Math.min(POLL_AFTER_EVENT_MS, timeoutMs), pollMs, aborted);
  }
  return pollForAnswer(call, contextUrl, beforeLeaf, timeoutMs, pollMs, aborted);
}

/** The event wait, told apart from a cancellation: an abort must not be reported as a failure. */
async function waitRunEnd(
  watcher: RunEndWatcher,
  sessionId: string,
  requestId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunEndResult> {
  if (!signal) return watcher.whenRunEnds(sessionId, requestId, timeoutMs);
  return Promise.race([
    watcher.whenRunEnds(sessionId, requestId, timeoutMs),
    new Promise<RunEndResult>((resolve) => {
      if (signal.aborted) return resolve({ ended: false });
      signal.addEventListener("abort", () => resolve({ ended: false }), { once: true });
    }),
  ]);
}

/** One read of the newest answer past the baseline, retried while the write may still be landing. */
async function readAnswer(
  call: (input: string, init?: RequestInit) => Promise<Response>,
  contextUrl: string,
  beforeLeaf: string,
  attempts = 3,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await call(contextUrl);
      if (r.ok) {
        const body = (await r.json()) as { leafId?: string; context?: unknown };
        if (body.leafId && body.leafId !== beforeLeaf) {
          const text = lastAssistantText(body.context);
          if (text) return text;
        }
      }
    } catch { /* the retry loop below, and then the poll */ }
    if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return "";
}

/**
 * The pre-ADR path: wait until pi looks idle, then read whatever the newest assistant message
 * says. `running` alone only says the wrapper is alive — it stays true between turns — so the run
 * inside it is what is tested, the same way the page reads it.
 */
async function pollForAnswer(
  call: (input: string, init?: RequestInit) => Promise<Response>,
  contextUrl: string,
  beforeLeaf: string,
  budgetMs: number,
  pollMs: number,
  aborted: () => boolean,
): Promise<string> {
  const enc = contextUrl.split("/")[3];
  const statusUrl = `/api/agent/${enc}?systemPrompt=0`;
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (aborted()) throw new PiRequestCancelled();
    let busy = true;
    try {
      const s = await call(statusUrl);
      if (s.ok) {
        const body = (await s.json()) as {
          running?: boolean;
          state?: { isStreaming?: boolean; isPromptRunning?: boolean } | null;
        };
        busy = Boolean(body.running && body.state && (body.state.isStreaming || body.state.isPromptRunning));
      }
    } catch { busy = true; }
    if (busy) continue;
    const text = await readAnswer(call, contextUrl, beforeLeaf, 1);
    if (text) return text;
  }
  throw new Error("pi did not answer in time");
}

/**
 * Stop the run the session is on, as the composer's Stop button does: queued
 * prompts come back to the composer and the wrapper tears itself down when the
 * run unwinds. Fire and forget — the voice layer already told the user.
 */
export async function stopPiRun(sessionId: string, opts: { fetchImpl?: (input: string, init?: RequestInit) => Promise<Response> } = {}): Promise<void> {
  const call = opts.fetchImpl ?? localApiFetch;
  try {
    await call(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "abort" }),
    });
  } catch { /* pi may already be idle */ }
}
