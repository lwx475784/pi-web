// The two-layer bridge: the voice layer asks this to run a real pi turn in the
// current session and returns pi's final answer text. It deliberately reuses
// the page's own REST surface (POST a prompt, poll status + the context tail),
// so no second event stream is opened and no pi internals are touched.

export interface AskPiOptions {
  timeoutMs?: number;
  pollMs?: number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Newest assistant message text in a session-context page, or "". */
export function lastAssistantText(context: unknown): string {
  if (!Array.isArray(context)) return "";
  for (let i = context.length - 1; i >= 0; i--) {
    const entry = context[i] as Record<string, unknown> | null;
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
 * assistant answer. Rejects if pi never gets idle with new output in time.
 */
export async function askPiReply(sessionId: string, question: string, opts: AskPiOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 1200;
  const call = opts.fetchImpl ?? localApiFetch;
  const enc = encodeURIComponent(sessionId);
  const contextUrl = `/api/sessions/${enc}/context?tail=8`;

  let beforeLeaf = "";
  try {
    const r = await call(contextUrl);
    if (r.ok) beforeLeaf = String(((await r.json()) as { leafId?: unknown }).leafId ?? "");
  } catch { /* best-effort baseline */ }

  const res = await call(`/api/agent/${enc}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "prompt", message: question }),
  });
  const sent = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok || sent.error) {
    throw new Error(sent.code === "prompt_rejected" ? "pi is busy" : (sent.error ?? `pi send failed (HTTP ${res.status})`));
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    let running = true;
    try {
      const s = await call(`/api/agent/${enc}?systemPrompt=0`);
      if (s.ok) running = Boolean((await s.json() as { running?: boolean }).running);
    } catch { running = true; }
    if (running) continue;
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
