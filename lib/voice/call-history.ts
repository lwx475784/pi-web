// Persistence for voice-call context: the call's transcript survives across
// panels, reloads and hang-ups, and a compact digest of it is replayed into
// every new realtime session so the voice layer remembers the previous scene.

export interface CallTurn {
  who: "me" | "ai" | "pi";
  text: string;
  at: number;
}

// What we keep locally per session, and what a new call is told about.
const MAX_TURNS = 40;
const MAX_REPLAY = 12;
/**
 * A call's transcript is conversation context, not a log to audit: after a day the scene it
 * describes is gone, and replaying last Tuesday's file paths into today's call is how an assistant
 * starts answering a question nobody asked. Rows written before timestamps existed carry no `at`
 * and are kept — silently dropping a user's history is worse than forgetting to expire it.
 */
export const CALL_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
/** Upper bound on the digest, in characters: a long answer does not ride on every later turn. */
export const MAX_REPLAY_CHARS = 4000;

function storage(): ItemStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

interface ItemStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
}

export function callHistoryKey(sessionId: string): string {
  return `pi-voice-call-${sessionId}`;
}

export function loadCallHistory(sessionId: string, store: ItemStorage | null = storage(), now: number = Date.now()): CallTurn[] {
  try {
    const raw = store?.getItem(callHistoryKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is CallTurn => !!t && typeof t === "object"
        && (t as CallTurn).who !== undefined && typeof (t as CallTurn).text === "string")
      .filter((t) => typeof t.at !== "number" || !Number.isFinite(t.at) || now - t.at <= CALL_HISTORY_TTL_MS)
      .slice(-MAX_TURNS);
  } catch {
    return [];
  }
}

/** Forget a session's call transcript: the "清除本通话记录" button, and nothing else. */
export function clearCallHistory(sessionId: string, store: ItemStorage | null = storage()): void {
  if (!sessionId) return;
  try {
    store?.removeItem?.(callHistoryKey(sessionId));
  } catch { /* storage unavailable: the next load expires on its own */ }
}

export function appendCallTurn(sessionId: string, turn: Omit<CallTurn, "at">, store: ItemStorage | null = storage()): CallTurn[] {
  const text = turn.text.trim();
  return text ? appendCallTurns(sessionId, [{ ...turn, text, at: Date.now() }], store) : loadCallHistory(sessionId, store);
}

/** Append finished turns (a migration) without rewriting their timestamps. */
function appendCallTurns(sessionId: string, turns: CallTurn[], store: ItemStorage | null): CallTurn[] {
  const trimmed = [...loadCallHistory(sessionId, store), ...turns].slice(-MAX_TURNS);
  try {
    store?.setItem(callHistoryKey(sessionId), JSON.stringify(trimmed));
  } catch { /* storage full or unavailable */ }
  return trimmed;
}

const LABELS: Record<CallTurn["who"], string> = { me: "我", ai: "助手", pi: "pi" };

/**
 * Move a call started before its session existed (a fresh composer's draft) onto
 * the session that first ask_pi created, so the transcript stays in one piece.
 */
export function migrateCallHistory(from: string, to: string, store: ItemStorage | null = storage()): void {
  if (!from || !to || from === to) return;
  const turns = loadCallHistory(from, store);
  if (!turns.length) return;
  appendCallTurns(to, turns, store);
  try {
    store?.removeItem?.(callHistoryKey(from));
  } catch { /* storage unavailable */ }
}

/**
 * The digest injected into a fresh realtime session ("input_text" item), or
 * "" when there is nothing worth replaying. Bounded on purpose: this context
 * rides on every later voice turn, and the shared LLM slot stays cheap.
 *
 * Newest turns first, and a turn that cannot fit is skipped rather than cut: a
 * half-sentence quoted from an old answer reads like a claim the voice layer
 * would then repeat back. Whole turns only, always.
 */
export function buildReplayMessage(turns: CallTurn[]): string {
  const header = "[之前的语音通话记录，只作背景，不用重复它]";
  const lines: string[] = [];
  let used = header.length;
  for (const turn of [...turns].reverse()) {
    if (lines.length >= MAX_REPLAY) break;
    const line = `${LABELS[turn.who]}: ${turn.text}`;
    if (used + line.length > MAX_REPLAY_CHARS) continue;
    lines.unshift(line);
    used += line.length + 1;
  }
  if (!lines.length) return "";
  return [header, ...lines].join("\n");
}
