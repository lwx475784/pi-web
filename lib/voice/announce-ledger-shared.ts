// The rules of the voice call's unread ledger — the list of answers that exist but were never
// spoken. Client-safe: no Node imports, so the page applies exactly what the server does
// (`lib/session-ui-state-shared.ts` is the precedent for splitting it this way).
//
// A voice ask can finish while the call is hung up, the tab hidden, or the announcement still
// queued behind somebody talking. Before ADR 0008 that was a silent loss: the answer landed on the
// page and the voice layer never mentioned it. The ledger is the bookkeeping that makes "漏播永不
// 静默" true — every finished ask is recorded, and an entry stops being unread only when the voice
// layer actually handed the text to the model.

/** Same shape as `lib/request-correlation.ts`: the id is opaque and bounded, never trusted. */
export const LEDGER_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** pi-web's session ids are UUIDs; the ledger keys by them, so bound what a caller may use as a key. */
export const MAX_SESSION_ID_LENGTH = 200;
/** An answer longer than this is read on the page, not spoken in parts. */
export const MAX_ANNOUNCEMENT_TEXT = 8000;
/** Entries kept per session; the oldest go first, unread or not. */
export const MAX_ANNOUNCEMENTS_PER_SESSION = 20;
/** A ledger older than this is stale: the call that would have read it is long gone. */
export const ANNOUNCEMENT_TTL_MS = 24 * 60 * 60 * 1000;

export type AnnouncementKind = "answer" | "failure" | "cancelled";

export interface VoiceAnnouncement {
  id: string;
  requestId: string;
  kind: AnnouncementKind;
  /** The question, so a count on the pill can be explained when the call opens again. */
  question: string;
  /** What would have been said. "" for a job that was stopped before it answered. */
  text: string;
  createdAt: number;
  /** null while it is unread. A cancelled job is written already-read: it is a record, not a message. */
  announcedAt: number | null;
}

export interface VoiceAnnouncementRequest {
  requestId?: unknown;
  kind?: unknown;
  question?: unknown;
  text?: unknown;
  /** Set when the entry is recorded as already delivered (a stop, or a replay written by the page). */
  announcedAt?: unknown;
}

const KINDS: AnnouncementKind[] = ["answer", "failure", "cancelled"];

/** A usable session key, or null when the id is missing, oversized, or full of path noise. */
export function normalizeSessionKey(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (!trimmed || trimmed.length > MAX_SESSION_ID_LENGTH) return null;
  return /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(trimmed) ? trimmed : null;
}

/** What the ledger accepts as a request body; anything else is a client bug, not a record. */
export function normalizeAnnouncementRequest(
  body: VoiceAnnouncementRequest | null | undefined,
): { requestId: string; kind: AnnouncementKind; question: string; text: string; announcedAt: number | null } | null {
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  if (!LEDGER_REQUEST_ID_PATTERN.test(requestId)) return null;
  const kind = KINDS.includes(body?.kind as AnnouncementKind) ? (body?.kind as AnnouncementKind) : null;
  if (!kind) return null;
  const question = typeof body?.question === "string" ? body.question.slice(0, 500) : "";
  const text = typeof body?.text === "string" ? body.text.slice(0, MAX_ANNOUNCEMENT_TEXT) : "";
  const rawAnnounced = body?.announcedAt;
  const announcedAt = typeof rawAnnounced === "number" && Number.isFinite(rawAnnounced) && rawAnnounced > 0
    ? Math.round(rawAnnounced)
    : null;
  return { requestId, kind, question, text, announcedAt };
}

/** Entries still owed to the user: recorded, never handed to the voice layer. */
export function unreadAnnouncements(list: readonly VoiceAnnouncement[]): VoiceAnnouncement[] {
  return list.filter((entry) => entry.announcedAt === null);
}

/**
 * Drop what is too old or too many, newest first. A stale entry is not lost information: the
 * answer it describes is still in the session, which is where a week-old reply is read anyway.
 */
export function pruneAnnouncements(
  list: readonly VoiceAnnouncement[],
  now: number,
): VoiceAnnouncement[] {
  const fresh = [...list]
    .filter((entry) => Number.isFinite(entry.createdAt) && now - entry.createdAt <= ANNOUNCEMENT_TTL_MS)
    .sort((a, b) => b.createdAt - a.createdAt);
  return fresh.slice(0, MAX_ANNOUNCEMENTS_PER_SESSION);
}

/** Add one record, then apply the bounds. The new entry is the head so a replay takes it first. */
export function recordAnnouncement(
  list: readonly VoiceAnnouncement[],
  entry: VoiceAnnouncement,
  now: number,
): VoiceAnnouncement[] {
  const withoutSameCall = list.filter((existing) => existing.requestId !== entry.requestId);
  return pruneAnnouncements([entry, ...withoutSameCall], now);
}

/** Mark entries as heard. Unknown ids are ignored: two devices may settle the same ledger. */
export function markAnnouncementsRead(
  list: readonly VoiceAnnouncement[],
  ids: readonly string[],
  now: number,
): VoiceAnnouncement[] {
  const wanted = new Set(ids.filter((id) => typeof id === "string" && id));
  if (wanted.size === 0) return pruneAnnouncements(list, now);
  return pruneAnnouncements(
    list.map((entry) => (wanted.has(entry.id) ? { ...entry, announcedAt: entry.announcedAt ?? now } : entry)),
    now,
  );
}

/** What a voice call should say when it opens: the newest unread, and how many more are behind it. */
export function replayPlan(list: readonly VoiceAnnouncement[]): { newest?: VoiceAnnouncement; more: number } {
  const unread = unreadAnnouncements([...list].sort((a, b) => b.createdAt - a.createdAt));
  const [newest, ...rest] = unread;
  return { ...(newest ? { newest } : {}), more: rest.length };
}
