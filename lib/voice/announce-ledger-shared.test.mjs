import assert from "node:assert/strict";
import test from "node:test";

import {
  ANNOUNCEMENT_TTL_MS,
  MAX_ANNOUNCEMENTS_PER_SESSION,
  markAnnouncementsRead,
  normalizeAnnouncementRequest,
  normalizeSessionKey,
  pruneAnnouncements,
  recordAnnouncement,
  replayPlan,
  unreadAnnouncements,
} from "./announce-ledger-shared.ts";

const NOW = 1_800_000_000_000;

function entry(over = {}) {
  return {
    id: "a-1",
    requestId: "r-1",
    kind: "answer",
    question: "问",
    text: "答",
    createdAt: NOW,
    announcedAt: null,
    ...over,
  };
}

test("normalizeSessionKey takes pi's ids and refuses anything that could be path noise", () => {
  assert.equal(normalizeSessionKey("01a2021b-72d2-70d1-b0ad-ad10ec1140e8"), "01a2021b-72d2-70d1-b0ad-ad10ec1140e8");
  for (const bad of [null, undefined, 7, "", "   ", "../x", "a/b", "a\\b", "x".repeat(201)]) {
    assert.equal(normalizeSessionKey(bad), null, String(bad));
  }
});

test("normalizeAnnouncementRequest needs a request id and a known kind", () => {
  assert.deepEqual(normalizeAnnouncementRequest({ requestId: " r-1 ", kind: "failure", question: "问", text: "答" }), {
    requestId: "r-1", kind: "failure", question: "问", text: "答", announcedAt: null,
  });
  assert.equal(normalizeAnnouncementRequest({ requestId: "", kind: "answer" }), null);
  assert.equal(normalizeAnnouncementRequest({ requestId: "r-1", kind: "别的" }), null);
  assert.equal(normalizeAnnouncementRequest(null), null);
  // Long answers stay on the page; the ledger keeps what can be spoken.
  const long = normalizeAnnouncementRequest({ requestId: "r-1", kind: "answer", question: "问".repeat(900), text: "答".repeat(9000) });
  assert.equal(long.text.length, 8000);
  assert.equal(long.question.length, 500);
});

test("pruneAnnouncements drops what is older than a day and caps the newest", () => {
  const stale = entry({ id: "old", createdAt: NOW - ANNOUNCEMENT_TTL_MS - 1 });
  const fresh = entry({ id: "new", createdAt: NOW - 1000 });
  assert.deepEqual(pruneAnnouncements([stale, fresh], NOW).map((e) => e.id), ["new"]);

  const many = Array.from({ length: MAX_ANNOUNCEMENTS_PER_SESSION + 5 }, (_, i) => entry({ id: `x${i}`, createdAt: NOW - i * 1000 }));
  const kept = pruneAnnouncements(many, NOW);
  assert.equal(kept.length, MAX_ANNOUNCEMENTS_PER_SESSION);
  assert.equal(kept[0].id, "x0", "newest first, so a replay speaks the freshest answer");
});

test("recordAnnouncement keeps one entry per request, newest wins", () => {
  const before = [entry({ id: "old", requestId: "r-1", text: "旧答" })];
  const after = recordAnnouncement(before, entry({ id: "new", requestId: "r-1", text: "新答" }), NOW);
  assert.deepEqual(after.map((e) => e.id), ["new"]);
});

test("an entry stops being unread only when the voice layer heard it", () => {
  const list = [entry({ id: "a" }), entry({ id: "b", announcedAt: NOW })];
  assert.deepEqual(unreadAnnouncements(list).map((e) => e.id), ["a"]);

  const read = markAnnouncementsRead(list, ["a", "unknown"], NOW);
  assert.deepEqual(unreadAnnouncements(read), []);
  assert.equal(read.find((e) => e.id === "b").announcedAt, NOW, "already-read entries keep their time");
});

test("replayPlan speaks one answer and counts the rest", () => {
  const list = [
    entry({ id: "old", createdAt: NOW - 5000, text: "旧" }),
    entry({ id: "new", createdAt: NOW, text: "新" }),
    entry({ id: "heard", createdAt: NOW - 1000, announcedAt: NOW }),
  ];
  const plan = replayPlan(list);
  assert.equal(plan.newest.id, "new");
  assert.equal(plan.more, 1);

  const nothing = replayPlan([entry({ id: "heard", announcedAt: NOW })]);
  assert.equal(nothing.newest, undefined);
  assert.equal(nothing.more, 0);
});
