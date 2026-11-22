import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// jiti, not a direct import: `lease-client.ts` pulls *values* (the retry budgets) from
// `./device-lease-shared`, and Node's type-stripping loader needs the extension webpack infers.
const jiti = createJiti(import.meta.url);
const { createLeaseClient, shouldReleaseOnRenewal } = await jiti.import("./lease-client.ts");

function fakeLeaseFetch({ claims = [], renew = null, offline = false } = {}) {
  const calls = [];
  let claimIndex = 0;
  const fetchImpl = async (_url, init) => {
    if (offline) throw new TypeError("offline");
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.action === "claim") {
      const reply = claims[Math.min(claimIndex++, claims.length - 1)] ?? { kind: "granted", self: false, displaced: null };
      return { ok: true, json: async () => reply };
    }
    if (body.action === "renew") {
      return { ok: true, json: async () => renew ?? { held: true, releaseRequested: false, takenOverBy: null } };
    }
    return { ok: true, json: async () => ({ released: true }) };
  };
  return { calls, fetchImpl };
}

async function waitFor(check, timeoutMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

test("the first caller gets the line and hands it back on stop", async () => {
  const { calls, fetchImpl } = fakeLeaseFetch({ claims: [{ kind: "granted", self: false, displaced: null }] });
  const lease = createLeaseClient({ ownerId: "A", label: "iPhone", fetchImpl });
  assert.deepEqual(await lease.acquire(), { ok: true, degraded: false });
  assert.deepEqual(calls[0], { action: "claim", ownerId: "A", label: "iPhone" });
  lease.stop();
  assert.ok(await waitFor(() => calls.some((call) => call.action === "release")));
});

test("a caller waits out the handover it starts, and gives up with the holder's name", async () => {
  const patient = fakeLeaseFetch({
    claims: [{ kind: "preempting", holderLabel: "Mac · mm" }, { kind: "granted", self: false, displaced: null }],
  });
  const lease = createLeaseClient({ ownerId: "B", label: "iPhone", fetchImpl: patient.fetchImpl, retryMs: 1, budgetMs: 200 });
  assert.deepEqual(await lease.acquire(), { ok: true, degraded: false });
  assert.equal(patient.calls.filter((call) => call.action === "claim").length, 2);
  lease.stop();

  const stubborn = fakeLeaseFetch({ claims: [{ kind: "preempting", holderLabel: "Mac · mm" }] });
  const second = createLeaseClient({ ownerId: "C", label: "笔记本", fetchImpl: stubborn.fetchImpl, retryMs: 1, budgetMs: 10 });
  assert.deepEqual(await second.acquire(), { ok: false, reason: "occupied", holderLabel: "Mac · mm" });
  second.stop();
});

test("a lease referee that is not there must not cost the user the call", async () => {
  const { fetchImpl } = fakeLeaseFetch({ offline: true });
  const lease = createLeaseClient({ ownerId: "A", label: "iPhone", fetchImpl });
  assert.deepEqual(await lease.acquire(), { ok: true, degraded: true });
  lease.stop();
});

test("the holder hangs up when a renewal says the line was taken, and names the taker", async () => {
  const taken = [];
  const { calls, fetchImpl } = fakeLeaseFetch({
    claims: [{ kind: "granted", self: false, displaced: null }],
    renew: { held: true, releaseRequested: true, takenOverBy: "iPhone · phone" },
  });
  const lease = createLeaseClient({
    ownerId: "A", label: "Mac · mm", fetchImpl, renewMs: 2,
    onReleaseRequested: (by) => taken.push(by),
  });
  await lease.acquire();
  assert.ok(await waitFor(() => taken.length === 1), "the renewal loop must notice the handover");
  assert.deepEqual(taken, ["iPhone · phone"]);
  assert.ok(calls.some((call) => call.action === "release"), "the slot is given back before the new caller retries");
  lease.stop();
});

test("shouldReleaseOnRenewal reads both ways the line can be gone", () => {
  assert.equal(shouldReleaseOnRenewal({ held: true, releaseRequested: true }), true);
  // A renewal that says we no longer hold it (a stale tab cleared us) is the same outcome.
  assert.equal(shouldReleaseOnRenewal({ held: false, releaseRequested: false }), true);
  assert.equal(shouldReleaseOnRenewal({ held: true, releaseRequested: false }), false);
  assert.equal(shouldReleaseOnRenewal(null), false, "an unreadable answer keeps the call alive");
});
