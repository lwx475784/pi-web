// Who holds the one voice line (ADR 0008 #7). Client-safe rules; the store lives in
// `lib/voice/device-lease.ts`.
//
// The deployed speech-to-speech server has a single pipeline slot, and it refuses — rather than
// preempts — a second client: `session_limit_reached`, then close 1008 with "Disconnect an existing
// client first". It has no API for "throw the other one out", so a takeover has to be arranged
// between the two browsers, with pi-web as the referee. That is what this is: one lease per
// deployment, renewed while a call is live, and a flag that tells the current holder to hang up.
//
// The later caller wins (the phone is usually the one now in the user's hand), and the displaced
// side must be *told* — today a dropped socket is silent, which is how "假在线" gets experienced:
// the pill still looks live while nobody can be heard.

/** A holder that misses this many renewals is gone; its lease is claimable by anyone. */
export const LEASE_TTL_MS = 12_000;
/** How often a live call renews, and how often a waiting caller retries its takeover. */
export const LEASE_RENEW_MS = 4_000;
export const LEASE_RETRY_MS = 700;
/** How long a caller waits for the holder to hand the line over before it gives up. */
export const LEASE_TAKEOVER_BUDGET_MS = 8_000;

export interface VoiceLeaseRecord {
  ownerId: string;
  /** What to show the displaced side: "mm 的浏览器", "iPhone", anything the caller chooses. */
  label: string;
  takenAt: number;
  renewedAt: number;
  /** Set when a later caller wants the line; the holder reads it on its next renewal. */
  releaseRequestedAt: number | null;
  /** Who asked, so the displaced device can be told a name instead of a shrug. */
  releaseRequestedBy: string | null;
}

export type ClaimOutcome =
  | { kind: "granted"; self: boolean; displaced: string | null }
  /** The line is held by somebody else, and they have just been asked to release it. */
  | { kind: "preempting"; holderLabel: string };

/** A short, opaque id for this page's call; two tabs on one machine are two owners. */
export const LEASE_OWNER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Labels are shown to a human, never used as a key. */
export const MAX_LEASE_LABEL_LENGTH = 80;

export function normalizeLeaseLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, MAX_LEASE_LABEL_LENGTH);
}

export function isUsableOwnerId(raw: unknown): raw is string {
  return typeof raw === "string" && LEASE_OWNER_PATTERN.test(raw);
}

/** A lease whose renewal is older than the TTL no longer protects anything. */
export function leaseIsStale(lease: VoiceLeaseRecord | null, now: number, ttlMs: number = LEASE_TTL_MS): boolean {
  return lease === null || now - lease.renewedAt > ttlMs;
}

/**
 * Take the line. Nobody holding it — or holding it stale — yields a grant; a live holder is asked
 * to release and the caller retries. A grant for the same owner is a renewal, not a new claim.
 * The label a grant records is the store's business, not the decision's, so it is not an argument.
 */
export function decideClaim(
  lease: VoiceLeaseRecord | null,
  now: number,
  ownerId: string,
): ClaimOutcome {
  if (lease && lease.ownerId === ownerId && !leaseIsStale(lease, now)) {
    return { kind: "granted", self: true, displaced: null };
  }
  const stale = leaseIsStale(lease, now);
  if (!lease || stale) {
    const displaced = lease && !stale ? lease.label : null;
    return { kind: "granted", self: false, displaced: displaced || null };
  }
  return { kind: "preempting", holderLabel: lease.label };
}

/** What a renewal answers: whether the holder has just been told to hang up. */
export function releaseIsRequested(lease: VoiceLeaseRecord | null): boolean {
  return lease?.releaseRequestedAt != null;
}
