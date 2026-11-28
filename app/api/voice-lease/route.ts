import { NextResponse } from "next/server";
import { claimLease, peekLease, releaseLease, renewLease } from "@/lib/voice/device-lease";
import { isUsableOwnerId, normalizeLeaseLabel } from "@/lib/voice/device-lease-shared";

// POST /api/voice-lease — one body, three actions:
//   { action: "claim",  ownerId, label } → { kind: "granted" | "preempting", ... }
//   { action: "renew",  ownerId }        → { held, releaseRequested }
//   { action: "release", ownerId }       → { released }
// GET /api/voice-lease → the current holder, for the debug panel and for a caller that wants to
// name the device occupying the line without asking for it.
//
// The lease exists because the speech-to-speech server has one pipeline slot and refuses rather
// than preempts (ADR 0008 #7). It is in-memory by design: a restart drops every call's socket
// anyway, and a durable record would resurrect a holder that is no longer holding anything.

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ lease: peekLease() });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    ownerId?: unknown;
    label?: unknown;
  };
  const ownerId = typeof body.ownerId === "string" ? body.ownerId : "";
  if (!isUsableOwnerId(ownerId)) {
    return NextResponse.json({ error: "ownerId is required" }, { status: 400 });
  }
  const action = body.action;
  if (action === "claim") {
    return NextResponse.json(claimLease(ownerId, normalizeLeaseLabel(body.label)));
  }
  if (action === "renew") {
    return NextResponse.json(renewLease(ownerId));
  }
  if (action === "release") {
    return NextResponse.json({ released: releaseLease(ownerId) });
  }
  return NextResponse.json({ error: `unknown action ${String(action)}` }, { status: 400 });
}
