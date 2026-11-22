import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  claimLease,
  peekLease,
  renewLease,
  releaseLease,
  resetLeaseForTests,
} = await jiti.import("./device-lease.ts");
const {
  decideClaim,
  isUsableOwnerId,
  leaseIsStale,
  normalizeLeaseLabel,
  LEASE_TTL_MS,
} = await jiti.import("./device-lease-shared.ts");

const T0 = 1_800_000_000_000;

test("the first caller is granted, the same caller renewing is granted again, and a live holder is preempted", () => {
  resetLeaseForTests();
  assert.deepEqual(claimLease("A", "Mac · mm", T0), { kind: "granted", self: false, displaced: null });
  assert.deepEqual(claimLease("A", "Mac · mm", T0 + 1000), { kind: "granted", self: true, displaced: null });
  assert.deepEqual(claimLease("B", "iPhone", T0 + 2000), { kind: "preempting", holderLabel: "Mac · mm" });
});

test("a stale lease is taken without asking, and names who it displaced", () => {
  resetLeaseForTests();
  claimLease("A", "Mac · mm", T0);
  const outcome = claimLease("B", "iPhone", T0 + LEASE_TTL_MS + 1);
  assert.deepEqual(outcome, { kind: "granted", self: false, displaced: null });
  assert.equal(peekLease()?.ownerId, "B", "a holder that stopped renewing no longer owns anything");
});

test("the holder learns on its next renewal that the line was taken, and by whom", () => {
  resetLeaseForTests();
  claimLease("A", "Mac · mm", T0);
  claimLease("B", "iPhone · phone", T0 + 1000);
  assert.deepEqual(renewLease("A", T0 + 1200), { held: true, releaseRequested: true, takenOverBy: "iPhone · phone" });

  // A caller that never got the line cannot be told by its own renewal.
  assert.deepEqual(renewLease("C", T0 + 1300), { held: false, releaseRequested: false, takenOverBy: null });
});

test("the holder releases for the waiting caller; a stranger may only clear a dead lease", () => {
  resetLeaseForTests();
  claimLease("A", "Mac", T0);
  claimLease("B", "iPhone", T0 + 500);
  assert.equal(releaseLease("C", T0 + 600), false, "C cannot hand over a line it never held");
  assert.equal(renewLease("A", T0 + 600).held, true);

  assert.equal(releaseLease("A", T0 + 700), true);
  assert.equal(peekLease(), null);
  assert.deepEqual(claimLease("B", "iPhone", T0 + 800), { kind: "granted", self: false, displaced: null });

  // A dead holder's lease is clearable by anyone, so nothing wedges on a closed tab.
  claimLease("D", "stale", T0 + 900);
  assert.equal(releaseLease("E", T0 + 900), false);
  assert.equal(releaseLease("E", T0 + 900 + LEASE_TTL_MS + 1), true);
});

test("the rules read the same from the pure helpers", () => {
  assert.equal(leaseIsStale(null, T0), true);
  assert.equal(leaseIsStale({ ownerId: "A", label: "a", takenAt: T0, renewedAt: T0, releaseRequestedAt: null, releaseRequestedBy: null }, T0 + LEASE_TTL_MS), false);
  assert.equal(leaseIsStale({ ownerId: "A", label: "a", takenAt: T0, renewedAt: T0, releaseRequestedAt: null, releaseRequestedBy: null }, T0 + LEASE_TTL_MS + 1), true);

  const held = { ownerId: "A", label: "  很长的标签".repeat(20), takenAt: T0, renewedAt: T0, releaseRequestedAt: null, releaseRequestedBy: null };
  assert.equal(decideClaim(held, T0, "A").kind, "granted");
  assert.equal(decideClaim(held, T0, "B").kind, "preempting");

  assert.equal(isUsableOwnerId("voice-1_2"), true);
  for (const bad of ["", "带空格", "x".repeat(65), 7, null]) assert.equal(isUsableOwnerId(bad), false, String(bad));
  assert.equal(normalizeLeaseLabel(undefined), "");
  assert.ok(normalizeLeaseLabel("x".repeat(500)).length <= 80);
});
