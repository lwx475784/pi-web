import assert from "node:assert/strict";
import test from "node:test";

import {
  decideAsk,
  decideStop,
  maySpeak,
  normalizeStopScope,
} from "./job-policy.ts";

test("an idle call starts the ask; a busy one queues only on the user's word", () => {
  assert.equal(decideAsk(0), "start");
  assert.equal(decideAsk(0, "queue"), "start", "nothing is running, so there is nothing to queue behind");
  assert.equal(decideAsk(1), "conflict");
  assert.equal(decideAsk(1, "queue"), "queue");
  assert.equal(decideAsk(2, "later"), "conflict", "an unknown when_busy is not permission");
});

test("only an attributable answer may be spoken", () => {
  assert.equal(maySpeak(true), true);
  assert.equal(maySpeak(false), false);
});

test("normalizeStopScope defaults to the narrowest thing a spoken stop can mean", () => {
  assert.equal(normalizeStopScope("announcements"), "announcements");
  assert.equal(normalizeStopScope("everything"), "everything");
  for (const raw of [undefined, null, "", "all", "ASK", 7]) assert.equal(normalizeStopScope(raw), "ask");
});

test("an ask is only cancelled when the call owns the run it would abort", () => {
  assert.equal(decideStop("ask", { confirmed: false, queuedCount: 3, ownsRun: true }), "cancel-ask");
  assert.equal(decideStop("ask", { confirmed: false, queuedCount: 0, ownsRun: false }), "explain-queued");
});

test("silencing announcements never touches what pi is doing", () => {
  assert.equal(decideStop("announcements", { confirmed: false, queuedCount: 5, ownsRun: true }), "mute-announcements");
  assert.equal(maySpeak(true), true, "muting is not the same as losing attribution");
});

test("a session-wide stop is offered first, then refused while the keyboard has work queued", () => {
  const unconfirmed = { confirmed: false, queuedCount: 0, ownsRun: true };
  assert.equal(decideStop("everything", unconfirmed), "ask-confirmation");

  const confirmedEmptyQueue = { confirmed: true, queuedCount: 0, ownsRun: true };
  assert.equal(decideStop("everything", confirmedEmptyQueue), "abort-session");

  // pi's abort empties the queue, and those prompts were typed by a page the user walked away
  // from: an unconfirmed "全部停止" must not silently cost them.
  const confirmedWithQueue = { confirmed: true, queuedCount: 2, ownsRun: false };
  assert.equal(decideStop("everything", confirmedWithQueue), "explain-queue");

  const staleConfirmation = { confirmed: false, queuedCount: 0, ownsRun: false };
  assert.equal(decideStop("everything", staleConfirmation), "ask-confirmation");
});
