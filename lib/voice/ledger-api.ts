// Client side of the voice call's unread ledger (`/api/sessions/[id]/voice-announcements`).
// Same shape as `pi-bridge.ts`: every call goes to the page's own same-origin API, and `fetchImpl`
// is injectable so the rules can be exercised without a browser.
//
// The ledger exists so a missed announcement is never silent: the page records every finished ask,
// and an entry stops being unread only when the voice layer actually handed its text to the model.

import type { VoiceAnnouncement } from "./announce-ledger-shared";

export interface LedgerApiOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface LedgerSnapshot {
  announcements: VoiceAnnouncement[];
  unread: VoiceAnnouncement[];
  replay: { newest?: VoiceAnnouncement; more: number };
}

function localApiFetch(input: string, init?: RequestInit): Promise<Response> {
  if (!input.startsWith("/api/")) throw new Error(`unexpected path: ${input}`);
  const url = new URL(input, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error(`unexpected origin: ${url.origin}`);
  const requestPageApi = globalThis.fetch;
  return requestPageApi(url.href, init);
}

function ledgerUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/voice-announcements`;
}

/** Everything the session still owes the user. */
export async function readLedger(sessionId: string, opts: LedgerApiOptions = {}): Promise<LedgerSnapshot> {
  const empty: LedgerSnapshot = { announcements: [], unread: [], replay: { more: 0 } };
  const fetchImpl = opts.fetchImpl ?? localApiFetch;
  try {
    const res = await fetchImpl(ledgerUrl(sessionId));
    if (!res.ok) return empty;
    const body = (await res.json()) as LedgerSnapshot;
    return {
      announcements: Array.isArray(body?.announcements) ? body.announcements : [],
      unread: Array.isArray(body?.unread) ? body.unread : [],
      replay: { ...(body?.replay?.newest ? { newest: body.replay.newest } : {}), more: body?.replay?.more ?? 0 },
    };
  } catch {
    return empty;
  }
}

/** Record that an ask finished. Returns the stored entry's id, or null when the ledger was unreachable. */
export async function recordAnnouncement(
  sessionId: string,
  entry: { requestId: string; kind: "answer" | "failure" | "cancelled"; question: string; text: string },
  opts: LedgerApiOptions = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? localApiFetch;
  try {
    const res = await fetchImpl(ledgerUrl(sessionId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { announcements?: VoiceAnnouncement[] };
    return body?.announcements?.find((candidate) => candidate.requestId === entry.requestId)?.id ?? null;
  } catch {
    return null;
  }
}

/** Mark entries heard, because the voice layer put their text in front of the model. */
export async function markAnnouncementsRead(
  sessionId: string,
  ids: readonly string[],
  opts: LedgerApiOptions = {},
): Promise<void> {
  if (ids.length === 0) return;
  const fetchImpl = opts.fetchImpl ?? localApiFetch;
  try {
    await fetchImpl(ledgerUrl(sessionId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...ids] }),
    });
  } catch { /* the next read reconciles */ }
}

/** Empty the session's ledger. */
export async function clearLedger(sessionId: string, opts: LedgerApiOptions = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? localApiFetch;
  try {
    await fetchImpl(ledgerUrl(sessionId), { method: "DELETE" });
  } catch { /* nothing to clear */ }
}
