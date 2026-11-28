// The voice call's unread ledger, as a file (`lib/voice/announce-ledger-shared.ts` holds the
// rules both sides apply). It lives beside pi's own files in the agent dir as
// `pi-web-voice-announcements.json`, because it is pi-web's state and never part of a session
// transcript: the pi CLI must not see it, and a session that is exported or forked should not
// carry a device's reading list with it.
//
// Deliberately lighter than `lib/session-ui-state.ts`: an unread-announcement list is 24 hours of
// "you were not listening", so a lost concurrent write costs one line, not a user's pins. Writes
// are still serialized in-process and replaced atomically, and a file that cannot be parsed is
// read as empty rather than overwritten on sight.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { readRegularFileText } from "../regular-file";
import {
  MAX_ANNOUNCEMENT_TEXT,
  normalizeSessionKey,
  pruneAnnouncements,
  recordAnnouncement,
  markAnnouncementsRead,
  unreadAnnouncements,
  type VoiceAnnouncement,
} from "./announce-ledger-shared";

const FILE_NAME = "pi-web-voice-announcements.json";
const LEDGER_VERSION = 1;
const MAX_BYTES = 2 * 1024 * 1024;

/** Route handlers are bundled separately and hot reload re-evaluates modules; globalThis keeps one queue per process. */
const QUEUE_KEY: symbol = Symbol.for("pi-web:voice-announcement-queue");
type QueueHolder = { tail: Promise<void> };

function queue(): QueueHolder {
  const globalHolder = globalThis as Record<symbol, QueueHolder | undefined>;
  let holder = globalHolder[QUEUE_KEY];
  if (!holder) {
    holder = { tail: Promise.resolve() };
    globalHolder[QUEUE_KEY] = holder;
  }
  return holder;
}

function ledgerPath(): string {
  return join(getAgentDir(), FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One stored entry, or null when the bytes on disk were not an entry. */
function parseEntry(value: unknown): VoiceAnnouncement | null {
  if (!isRecord(value)) return null;
  const { id, requestId, kind, question, text, createdAt, announcedAt } = value;
  if (typeof id !== "string" || !id || typeof requestId !== "string" || !requestId) return null;
  if (kind !== "answer" && kind !== "failure" && kind !== "cancelled") return null;
  if (typeof question !== "string" || typeof text !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (announcedAt !== null && (typeof announcedAt !== "number" || !Number.isFinite(announcedAt))) return null;
  return {
    id,
    requestId,
    kind,
    question: question.slice(0, 500),
    text: text.slice(0, MAX_ANNOUNCEMENT_TEXT),
    createdAt,
    announcedAt: announcedAt === null ? null : Math.round(announcedAt as number),
  };
}

/** Every session's list, with the shared bounds applied on the way in, so a hand-edited file cannot grow the ledger. */
function parseLedger(raw: string | undefined): Record<string, VoiceAnnouncement[]> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const sessions = isRecord(parsed) ? parsed["sessions"] : undefined;
  if (!isRecord(sessions)) return {};
  const now = Date.now();
  const out: Record<string, VoiceAnnouncement[]> = {};
  for (const [key, list] of Object.entries(sessions)) {
    const sessionKey = normalizeSessionKey(key);
    if (!sessionKey || !Array.isArray(list)) continue;
    const entries = list.map(parseEntry).filter((entry): entry is VoiceAnnouncement => entry !== null);
    const pruned = pruneAnnouncements(entries, now);
    if (pruned.length) out[sessionKey] = pruned;
  }
  return out;
}

function readLedger(): Record<string, VoiceAnnouncement[]> {
  try {
    return parseLedger(readRegularFileText(ledgerPath(), MAX_BYTES));
  } catch {
    // An unreadable file is not a reason to lose the call: read it as empty and leave it alone.
    return {};
  }
}

function writeLedger(sessions: Record<string, VoiceAnnouncement[]>): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify({ version: LEDGER_VERSION, sessions }));
}

/** Run one read-modify-write on the ledger, serialized against every other one in this process. */
function withLedger<T>(mutate: (sessions: Record<string, VoiceAnnouncement[]>) => T): Promise<T> {
  const holder = queue();
  const run = holder.tail.then(() => {
    const sessions = readLedger();
    const result = mutate(sessions);
    writeLedger(sessions);
    return result;
  });
  holder.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * What a session owes the user, newest first. A read never writes: expiry and the cap are applied
 * on the way out, and the next record rewrites the file with them. That keeps a file this process
 * cannot parse (hand-edited, or another pi-web's newer format) from being quietly emptied by a
 * page that only came to look.
 */
export async function readSessionAnnouncements(sessionId: string): Promise<VoiceAnnouncement[]> {
  const key = normalizeSessionKey(sessionId);
  if (!key) return [];
  return pruneAnnouncements(readLedger()[key] ?? [], Date.now());
}

/** Record that an ask finished. `entry.announcedAt` decides whether it also lands in the unread set. */
export async function recordSessionAnnouncement(
  sessionId: string,
  entry: VoiceAnnouncement,
): Promise<VoiceAnnouncement[]> {
  const key = normalizeSessionKey(sessionId);
  if (!key) return [];
  return await withLedger((sessions) => {
    sessions[key] = recordAnnouncement(sessions[key] ?? [], entry, Date.now());
    return sessions[key];
  });
}

/** Mark entries heard, because the voice layer put their text in front of the model. */
export async function markSessionAnnouncementsRead(
  sessionId: string,
  ids: readonly string[],
): Promise<VoiceAnnouncement[]> {
  const key = normalizeSessionKey(sessionId);
  if (!key) return [];
  return await withLedger((sessions) => {
    const list = markAnnouncementsRead(sessions[key] ?? [], ids, Date.now());
    if (list.length) sessions[key] = list;
    else delete sessions[key];
    return list;
  });
}

/** Empty a session's ledger: the user cleared the call, so nothing is owed any more. */
export async function clearSessionAnnouncements(sessionId: string): Promise<void> {
  const key = normalizeSessionKey(sessionId);
  if (!key) return;
  await withLedger((sessions) => {
    delete sessions[key];
  });
}

/** Unread entries, newest first — what a call replays when it opens. */
export function unreadFrom(list: readonly VoiceAnnouncement[]): VoiceAnnouncement[] {
  return unreadAnnouncements(list);
}

/** Drop the cached queue between tests so one file never leaks into the next case. */
export function resetVoiceAnnouncementQueueForTests(): void {
  (globalThis as Record<symbol, QueueHolder | undefined>)[QUEUE_KEY] = { tail: Promise.resolve() };
}
