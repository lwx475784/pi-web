import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clearSessionAnnouncements,
  markSessionAnnouncementsRead,
  readSessionAnnouncements,
  recordSessionAnnouncement,
  resetVoiceAnnouncementQueueForTests,
} = await jiti.import("./announce-ledger.ts");

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-voice-ledger-"));
  const agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetVoiceAnnouncementQueueForTests();
  t.after(() => {
    resetVoiceAnnouncementQueueForTests();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { agentDir, path: join(agentDir, "pi-web-voice-announcements.json") };
}

function entry(over = {}) {
  return {
    id: "a-1",
    requestId: "r-1",
    kind: "answer",
    question: "查一下定时任务",
    text: "都在 ~/Library/LaunchAgents",
    createdAt: Date.now(),
    announcedAt: null,
    ...over,
  };
}

test("the ledger round-trips through a private file in the agent dir", async (t) => {
  const { path } = fixture(t);
  await recordSessionAnnouncement("s-1", entry());
  const mode = fs.statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, "the questions the user spoke aloud are not world-readable");

  const list = await readSessionAnnouncements("s-1");
  assert.equal(list.length, 1);
  assert.equal(list[0].requestId, "r-1");
});

test("marks-read, clear and per-session keys stay separate", async (t) => {
  fixture(t);
  await recordSessionAnnouncement("s-1", entry());
  await recordSessionAnnouncement("s-1", entry({ id: "a-2", requestId: "r-2" }));
  await recordSessionAnnouncement("s-2", entry({ id: "b-1", requestId: "r-9" }));

  const after = await markSessionAnnouncementsRead("s-1", ["a-2"]);
  assert.deepEqual(after.filter((e) => e.announcedAt === null).map((e) => e.id), ["a-1"]);
  assert.equal((await readSessionAnnouncements("s-2")).length, 1);

  await clearSessionAnnouncements("s-1");
  assert.deepEqual(await readSessionAnnouncements("s-1"), []);
  assert.equal((await readSessionAnnouncements("s-2")).length, 1);
});

test("a corrupt file reads as empty and is not overwritten on sight", async (t) => {
  const { path, agentDir } = fixture(t);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path, "{not json");
  assert.deepEqual(await readSessionAnnouncements("s-1"), []);
  assert.equal(fs.readFileSync(path, "utf8"), "{not json", "a read must not clobber what it could not parse");
});

test("entries older than a day are gone, and junk in the file is ignored", async (t) => {
  const { path, agentDir } = fixture(t);
  const day = 24 * 60 * 60 * 1000;
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path, JSON.stringify({
    version: 1,
    sessions: {
      "s-1": [
        entry({ id: "old", createdAt: Date.now() - day - 60_000 }),
        entry({ id: "fresh", createdAt: Date.now() - 1000 }),
        { id: "junk" },
        "not an entry",
      ],
      "bad key/../x": [entry({ id: "other" })],
    },
  }));
  const list = await readSessionAnnouncements("s-1");
  assert.deepEqual(list.map((e) => e.id), ["fresh"]);
});

test("the cap keeps the newest twenty, so a week of unread answers cannot grow the file", async (t) => {
  fixture(t);
  for (let i = 0; i < 25; i++) {
    await recordSessionAnnouncement("s-1", entry({ id: `x${i}`, requestId: `r-${i}`, createdAt: Date.now() - i * 1000 }));
  }
  const list = await readSessionAnnouncements("s-1");
  assert.equal(list.length, 20);
  assert.equal(list[0].id, "x0", "newest first, so a replay speaks the freshest answer");
});

test("two devices settling one ledger: the second read receipt cannot unread the first", async (t) => {
  fixture(t);
  await recordSessionAnnouncement("s-1", entry({ id: "a-1", requestId: "r-1" }));
  await recordSessionAnnouncement("s-1", entry({ id: "a-2", requestId: "r-2" }));

  // mm speaks one, the phone speaks the other: both mark their own, and neither re-opens it.
  await markSessionAnnouncementsRead("s-1", ["a-1"]);
  const after = await markSessionAnnouncementsRead("s-1", ["a-2"]);
  assert.deepEqual(after.filter((e) => e.announcedAt === null), []);

  const same = await markSessionAnnouncementsRead("s-1", ["a-1"]);
  assert.equal(same.find((e) => e.id === "a-1").announcedAt !== null, true);
});

test("a re-ask with the same request id replaces its record instead of stacking", async (t) => {
  fixture(t);
  await recordSessionAnnouncement("s-1", entry({ id: "a-1", requestId: "r-1", text: "第一次的答" }));
  const list = await recordSessionAnnouncement("s-1", entry({ id: "a-2", requestId: "r-1", text: "重试后的答" }));
  assert.deepEqual(list.map((e) => e.id), ["a-2"]);
});
