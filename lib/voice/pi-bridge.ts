// The two-layer bridge: the voice layer asks this to run a real pi turn in the
// current session and returns pi's final answer text. It deliberately reuses
// the page's own REST surface (POST a prompt, poll status + the context tail),
// so no second event stream is opened and no pi internals are touched.

export interface AskPiOptions {
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Stop waiting when the user cancels; `stopPiRun` stops pi itself. */
  signal?: AbortSignal;
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
 * Send `question` as a pi prompt to `sessionId` and wait (poll) for the next
 * assistant answer. Rejects if pi never gets idle with new output in time, or
 * when `signal` aborts.
 */
export async function askPiReply(sessionId: string, question: string, opts: AskPiOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 1200;
  const call = opts.fetchImpl ?? localApiFetch;
  const enc = encodeURIComponent(sessionId);
  const contextUrl = `/api/sessions/${enc}/context?tail=8`;
  const aborted = () => opts.signal?.aborted === true;

  let beforeLeaf = "";
  try {
    const r = await call(contextUrl, opts.signal ? { signal: opts.signal } : undefined);
    if (r.ok) beforeLeaf = String(((await r.json()) as { leafId?: unknown }).leafId ?? "");
  } catch { /* best-effort baseline */ }
  if (aborted()) throw new PiRequestCancelled();

  const res = await call(`/api/agent/${enc}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: question }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (aborted()) throw new PiRequestCancelled();
  const sent = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok || sent.error) {
    throw new Error(sent.code === "prompt_rejected" ? "pi is busy" : (sent.error ?? `pi send failed (HTTP ${res.status})`));
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (aborted()) throw new PiRequestCancelled();
    let busy = true;
    try {
      const s = await call(`/api/agent/${enc}?systemPrompt=0`);
      if (s.ok) {
        const body = (await s.json()) as {
          running?: boolean;
          state?: { isStreaming?: boolean; isPromptRunning?: boolean } | null;
        };
        // Top-level `running` only says the wrapper is alive — it stays true
        // between turns, so waiting for it to drop waits for the idle timeout.
        // The page reads a run the same way: streaming, or a prompt inside it.
        busy = Boolean(body.running && body.state && (body.state.isStreaming || body.state.isPromptRunning));
      }
    } catch { busy = true; }
    if (busy) continue;
    try {
      const r = await call(contextUrl);
      if (!r.ok) continue;
      const body = (await r.json()) as { leafId?: string; context?: unknown };
      if (!body.leafId || body.leafId === beforeLeaf) continue; // nothing new written yet
      const text = lastAssistantText(body.context);
      if (text) return text;
    } catch { /* keep polling until the deadline */ }
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
