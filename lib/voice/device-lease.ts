// The voice line's single lease, held in memory (`lib/voice/device-lease-shared.ts` has the rules).
//
// Nothing here outlives the process on purpose: the lease only means something while both browsers
// are connected to the same pi-web and the same speech-to-speech slot. If pi-web restarts, every
// call's socket dropped with it, and a durable record would only resurrect a device that is no
// longer holding anything. A holder that goes away silently is covered instead by the renewal TTL.

import {
  decideClaim,
  leaseIsStale,
  normalizeLeaseLabel,
  releaseIsRequested,
  type ClaimOutcome,
  type VoiceLeaseRecord,
} from "./device-lease-shared";

let lease: VoiceLeaseRecord | null = null;

/** A plain copy for a response: the caller never needs the live object. */
function snapshot(value: VoiceLeaseRecord | null): VoiceLeaseRecord | null {
  return value ? { ...value } : null;
}

/**
 * Ask for the line. A grant is also a renewal when the same owner asks again, and a refusal marks
 * the current holder as asked-to-release, so the caller's retries are what eventually land.
 */
export function claimLease(ownerId: string, label: string, now: number = Date.now()): ClaimOutcome {
  const outcome = decideClaim(lease, now, ownerId);
  if (outcome.kind === "granted") {
    lease = {
      ownerId,
      label: normalizeLeaseLabel(label) || "另一台设备",
      takenAt: now,
      renewedAt: now,
      releaseRequestedAt: null,
      releaseRequestedBy: null,
    };
    return outcome;
  }
  if (lease && lease.releaseRequestedAt === null) {
    lease = { ...lease, releaseRequestedAt: now, releaseRequestedBy: normalizeLeaseLabel(label) || "另一台设备" };
  }
  return outcome;
}

/** Renew, and learn whether the holder has just been told to hang up, and by whom. */
export function renewLease(
  ownerId: string,
  now: number = Date.now(),
): { held: boolean; releaseRequested: boolean; takenOverBy: string | null } {
  if (!lease || lease.ownerId !== ownerId) return { held: false, releaseRequested: false, takenOverBy: null };
  lease = { ...lease, renewedAt: now };
  return {
    held: true,
    releaseRequested: releaseIsRequested(lease),
    takenOverBy: lease.releaseRequestedBy ?? null,
  };
}

/** Give the line back. A non-holder may clear a lease only once it has gone stale. */
export function releaseLease(ownerId: string, now: number = Date.now()): boolean {
  if (!lease) return true;
  if (lease.ownerId === ownerId) {
    lease = null;
    return true;
  }
  if (leaseIsStale(lease, now)) {
    lease = null;
    return true;
  }
  return false;
}

/** What the debug panel and a waiting caller can see without owning anything. */
export function peekLease(): VoiceLeaseRecord | null {
  return snapshot(lease);
}

/** Tests must not inherit another case's holder. */
export function resetLeaseForTests(): void {
  lease = null;
}
