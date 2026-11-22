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

export function loadCallHistory(sessionId: string, store: ItemStorage | null = storage()): CallTurn[] {
  try {
    const raw = store?.getItem(callHistoryKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t): t is CallTurn => !!t && typeof t === "object"
        && (t as CallTurn).who !== undefined && typeof (t as CallTurn).text === "string")
      .slice(-MAX_TURNS);
  } catch {
    return [];
  }
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
 */
export function buildReplayMessage(turns: CallTurn[]): string {
  const recent = turns.slice(-MAX_REPLAY);
  if (!recent.length) return "";
  const lines = recent.map((t) => `${LABELS[t.who]}: ${t.text}`);
  return ["[之前的语音通话记录，只作背景，不用重复它]", ...lines].join("\n");
}
