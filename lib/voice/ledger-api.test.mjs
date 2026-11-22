import assert from "node:assert/strict";
import test from "node:test";

import { clearLedger, markAnnouncementsRead, readLedger, recordAnnouncement } from "./ledger-api.ts";

const SID = "01a2021b-72d2-70d1";

function fakeFetch(responses = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const method = init?.method ?? "GET";
    seen.push({ url, method, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses[method];
    if (next instanceof Error) throw next;
    if (!next) return { ok: true, json: async () => ({ announcements: [], unread: [], replay: { more: 0 } }) };
    return { ok: next.ok ?? true, json: async () => next.body };
  };
  return { seen, fetchImpl };
}

test("readLedger asks for the session's own ledger and survives a sparse body", async () => {
  const { seen, fetchImpl } = fakeFetch({
    GET: { body: { announcements: [{ id: "a-1" }], unread: null, replay: {} } },
  });
  const snapshot = await readLedger(SID, { fetchImpl });
  assert.equal(seen[0].url, `/api/sessions/${SID}/voice-announcements`);
  assert.equal(snapshot.announcements.length, 1);
  assert.deepEqual(snapshot.unread, []);
  assert.equal(snapshot.replay.more, 0);
});

test("readLedger reads as empty when the route or the network fails", async () => {
  const offline = await readLedger(SID, { fetchImpl: async () => { throw new TypeError("offline"); } });
  assert.deepEqual(offline, { announcements: [], unread: [], replay: { more: 0 } });
  const missing = await readLedger(SID, { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  assert.equal(missing.unread.length, 0);
});

test("recordAnnouncement returns the stored id, which is the tag that later marks it heard", async () => {
  const { seen, fetchImpl } = fakeFetch({
    POST: { body: { announcements: [{ id: "a-9", requestId: "r-1" }, { id: "a-1", requestId: "r-0" }] } },
  });
  const id = await recordAnnouncement(SID, { requestId: "r-1", kind: "answer", question: "问", text: "答" }, { fetchImpl });
  assert.equal(id, "a-9");
  assert.deepEqual(seen[0], {
    url: `/api/sessions/${SID}/voice-announcements`,
    method: "POST",
    body: { requestId: "r-1", kind: "answer", question: "问", text: "答" },
  });
});

test("a ledger that cannot be reached still announces: no id, no read receipt, no silence", async () => {
  const id = await recordAnnouncement(SID, { requestId: "r-1", kind: "failure", question: "问", text: "答" }, {
    fetchImpl: async () => ({ ok: false, json: async () => ({ error: "boom" }) }),
  });
  assert.equal(id, null);
});

test("markAnnouncementsRead posts the ids it was given and skips an empty set", async () => {
  const { seen, fetchImpl } = fakeFetch();
  await markAnnouncementsRead(SID, ["a-1", "a-2"], { fetchImpl });
  assert.deepEqual(seen[0], {
    url: `/api/sessions/${SID}/voice-announcements`,
    method: "PATCH",
    body: { ids: ["a-1", "a-2"] },
  });
  const quiet = fakeFetch();
  await markAnnouncementsRead(SID, [], { fetchImpl: quiet.fetchImpl });
  assert.equal(quiet.seen.length, 0);
});

test("clearLedger deletes the session's list and stays quiet offline", async () => {
  const { seen, fetchImpl } = fakeFetch();
  await clearLedger(SID, { fetchImpl });
  assert.equal(seen[0].method, "DELETE");
  await clearLedger(SID, { fetchImpl: async () => { throw new TypeError("offline"); } });
});
