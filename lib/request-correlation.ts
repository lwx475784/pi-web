/**
 * Correlation ids for prompts that arrive over RPC.
 *
 * pi's SDK gives a caller no id for a submission: `prompt()` resolves to `void`, and the only
 * acknowledgement is `preflightResult("started" | "queued" | "handled")`. A REST client that must
 * later learn *which* run its own message started — the voice call, above all, where speaking
 * somebody else's answer is a worse failure than speaking nothing — therefore brings its own id
 * (ADR 0008). The wrapper then has to match that id back to the user message pi appends, and
 * matching happens here, as a pure function over what the two sides carry.
 *
 * The match is by text, oldest submission first. Ids are never claimed on a guess: an unmatched
 * message gets no id, and the caller falls back to polling rather than acting on a wrong pairing.
 */

export interface PendingRequestId {
  requestId: string;
  /** The prompt text as submitted, before pi's own templates or skills can rewrite it. */
  text: string;
}

/** How many unclaimed ids the wrapper keeps. Older ones are dropped, so a lost prompt cannot pin the list. */
export const PENDING_REQUEST_ID_LIMIT = 32;

/** A caller-supplied id is opaque and bounded: long enough for a UUID, short enough to echo freely. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Accept a caller's correlation id, or `undefined` when it is absent, oddly shaped, or too long. */
export function normalizeRequestId(raw: unknown): string | undefined {
  return typeof raw === "string" && REQUEST_ID_PATTERN.test(raw.trim()) ? raw.trim() : undefined;
}

/** Text of a user message, in whichever shape the SDK carries it. "" when there is none to match. */
export function extractMessageText(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.find((block) => (block as { type?: string } | null)?.type === "text") as { text?: unknown } | undefined;
    return typeof text?.text === "string" ? text.text : "";
  }
  return "";
}

/** Collapse whitespace so a reflowed prompt still matches the text it was submitted as. */
function fold(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Take the pending id that belongs to this delivered message, removing it from the list.
 *
 * Exact text first, then whitespace-folded text, and always the oldest of the matches: two
 * identical asks are answered in the order they were sent. Nothing matches when the message was
 * rewritten past recognition (a skill block, a template), and the caller then waits on its
 * fallback instead of pairing the answer with the wrong question.
 */
export function claimRequestId(pending: PendingRequestId[], text: string): PendingRequestId | null {
  if (!pending.length || !text) return null;
  let index = pending.findIndex((entry) => entry.text === text);
  if (index === -1) {
    const folded = fold(text);
    index = pending.findIndex((entry) => fold(entry.text) === folded);
  }
  if (index === -1) return null;
  const [claimed] = pending.splice(index, 1);
  return claimed ?? null;
}

/** Record a submission, dropping the oldest when the list overflows. No id, no record. */
export function rememberRequestId(
  pending: PendingRequestId[],
  requestId: string | undefined,
  text: string,
): void {
  if (!requestId) return;
  if (pending.length >= PENDING_REQUEST_ID_LIMIT) pending.shift();
  pending.push({ requestId, text });
}
