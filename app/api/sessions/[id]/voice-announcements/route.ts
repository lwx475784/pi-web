import { NextResponse } from "next/server";
import {
  clearSessionAnnouncements,
  markSessionAnnouncementsRead,
  readSessionAnnouncements,
  recordSessionAnnouncement,
} from "@/lib/voice/announce-ledger";
import {
  normalizeAnnouncementRequest,
  normalizeSessionKey,
  replayPlan,
  type VoiceAnnouncement,
} from "@/lib/voice/announce-ledger-shared";
import { randomUUID } from "crypto";

// /api/sessions/[id]/voice-announcements — the voice call's unread ledger (ADR 0008).
//
// GET    → { announcements, unread, replay: { newest, more } }
// POST   → record one finished ask: { requestId, kind, question, text, announcedAt? }
// PATCH  → mark entries heard: { ids: [...] }
// DELETE → empty the session's ledger
//
// The session file is not resolved here on purpose: a call promoted from a fresh composer can
// record an answer the moment the session id exists, and the ledger is keyed by that id. A bad id
// shape is rejected; nothing about it touches the filesystem.

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function unknownSession(sessionId: string | null) {
  return sessionId === null
    ? NextResponse.json({ error: "Session id is not a usable ledger key" }, { status: 400 })
    : null;
}

function withUnread(announcements: VoiceAnnouncement[]) {
  const plan = replayPlan(announcements);
  return NextResponse.json({
    announcements,
    unread: announcements.filter((entry) => entry.announcedAt === null),
    replay: { ...(plan.newest ? { newest: plan.newest } : {}), more: plan.more },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const key = normalizeSessionKey(id);
  const rejected = unknownSession(key);
  if (rejected) return rejected;
  try {
    return withUnread(await readSessionAnnouncements(key!));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const key = normalizeSessionKey(id);
  const rejected = unknownSession(key);
  if (rejected) return rejected;
  const body = await req.json().catch(() => null);
  const request = normalizeAnnouncementRequest(body as never);
  if (!request) return badRequest("requestId, kind and text are required");
  try {
    const entry: VoiceAnnouncement = {
      id: randomUUID(),
      requestId: request.requestId,
      kind: request.kind,
      question: request.question,
      text: request.text,
      createdAt: Date.now(),
      announcedAt: request.announcedAt ?? (request.kind === "cancelled" ? Date.now() : null),
    };
    return withUnread(await recordSessionAnnouncement(key!, entry));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const key = normalizeSessionKey(id);
  const rejected = unknownSession(key);
  if (rejected) return rejected;
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body?.ids)
    ? body.ids.filter((value): value is string => typeof value === "string" && value.length > 0).slice(0, 50)
    : [];
  if (ids.length === 0) return badRequest("ids is required");
  try {
    return withUnread(await markSessionAnnouncementsRead(key!, ids));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const key = normalizeSessionKey(id);
  const rejected = unknownSession(key);
  if (rejected) return rejected;
  try {
    await clearSessionAnnouncements(key!);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
