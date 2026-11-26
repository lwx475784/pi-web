import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// Through jiti: the module imports values of other modules without extensions.
const jiti = createJiti(import.meta.url);
const { isBashDraft, referenceDraftValue, sessionReferenceMarkdown } = await jiti.import("./session-reference.ts");

const FILE = "2026-11-25T22-02-10-212Z_01a214bb-03a4-7532-9260-6ed08e100d5a.jsonl";
const zhLabel = (title) => `引用会话「${title}」`;
const enLabel = (title) => `Reference session "${title}"`;

test("a named session becomes one markdown link: its row title and its session file", () => {
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", name: "PR#1030 状态栏命令按钮", firstMessage: "", path: `/Users/me/.pi/agent/sessions/--proj--/${FILE}` },
      zhLabel,
    ),
    `[引用会话「PR#1030 状态栏命令按钮」](/Users/me/.pi/agent/sessions/--proj--/${FILE})`,
  );
});

test("an unnamed row is titled as the list titles it: first message, else its id", () => {
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", firstMessage: "怎么加一个 Web UI", path: `/p/${FILE}` },
      zhLabel,
    ),
    `[引用会话「怎么加一个 Web UI」](/p/${FILE})`,
  );
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", firstMessage: "", path: `/p/${FILE}` },
      zhLabel,
    ),
    `[引用会话「01a214bb-03a」](/p/${FILE})`,
  );
});

test("a fork row keeps the suffix its row shows", () => {
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", name: "PR#1030 状态栏命令按钮 · 3f9a", firstMessage: "", path: `/p/${FILE}` },
      zhLabel,
    ),
    `[引用会话「PR#1030 状态栏命令按钮 · 3f9a」](/p/${FILE})`,
  );
});

test("a title with markdown brackets keeps the link whole", () => {
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", name: "改 [bug] 修好了", firstMessage: "", path: `/p/${FILE}` },
      zhLabel,
    ),
    `[引用会话「改 \\[bug\\] 修好了」](/p/${FILE})`,
  );
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", name: "a\\b", firstMessage: "", path: `/p/${FILE}` },
      zhLabel,
    ),
    `[引用会话「a\\\\b」](/p/${FILE})`,
  );
});

test("a Windows session file reaches the model with forward slashes", () => {
  // A backslash destination loses its href in pi-web's Markdown (docs/agents/
  // sessions.md "Windows Markdown file links"), and pi itself gives the model
  // forward-slash paths.
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", name: "N", firstMessage: "", path: `C:\\Users\\me\\.pi\\agent\\sessions\\--p--\\${FILE}` },
      zhLabel,
    ),
    `[引用会话「N」](C:/Users/me/.pi/agent/sessions/--p--/${FILE})`,
  );
});

test("a path with spaces or parentheses keeps its address whole", () => {
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", name: "N", firstMessage: "", path: `/Users/My Project/.pi/agent/sessions/--p--/${FILE}` },
      zhLabel,
    ),
    `[引用会话「N」](</Users/My Project/.pi/agent/sessions/--p--/${FILE}>)`,
  );
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", name: "N", firstMessage: "", path: `/Users/a (2)/${FILE}` },
      zhLabel,
    ),
    `[引用会话「N」](</Users/a (2)/${FILE}>)`,
  );
});

test("a `!` command draft takes the reference as typed text, not as a paragraph", () => {
  // ChatInput runs a draft as a shell command only while no image is attached
  // (its bashMode), and a command must not gain blank lines.
  assert.equal(isBashDraft({ value: "! grep -c error " }), true);
  assert.equal(isBashDraft({ value: "  !ssh mm status" }), true);
  assert.equal(isBashDraft({ value: "!", images: [] }), true);
  assert.equal(isBashDraft({ value: "! look", images: [{}, {}] }), false);
  assert.equal(isBashDraft({ value: "怎么加一个 Web UI" }), false);
  assert.equal(isBashDraft(null), false);
});

test("with no composer mounted the reference still lands in the draft, as its own paragraph", () => {
  const line = `[引用会话「N」](/p/${FILE})`;
  assert.equal(referenceDraftValue(null, line), line);
  assert.equal(referenceDraftValue({ value: "" }, line), line);
  assert.equal(referenceDraftValue({ value: "问个问题" }, line), `问个问题\n\n${line}`);
  assert.equal(referenceDraftValue({ value: "问个问题\n\n" }, line), `问个问题\n\n${line}`);
  // A blank line always goes above the reference: quoteSeparator adds the
  // newline that turns the one the draft already ends with into a blank line.
  assert.equal(referenceDraftValue({ value: "问个问题\n" }, line), `问个问题\n\n${line}`);
});

test("the module stays browser-safe, or the production build fails on it", async () => {
  // A client component imports it (components/AppShell.tsx), so webpack resolves
  // it for the browser: `fs` or `path` anywhere in what it imports — including
  // through lib/paths.ts, the repo's own path helper — fails `next build`, while
  // tsc --noEmit and npm test both pass and say nothing. The one path conversion
  // it needs is therefore written inline, not imported.
  const source = await readFile(new URL("./session-reference.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  const nodeOnly = specifiers.filter((specifier) => /^(node:)?(fs|path|os|child_process)$/.test(specifier) || specifier === "./paths");
  assert.deepEqual(nodeOnly, [], `client-safe imports only, found: ${nodeOnly.join(", ")}`);
});

test("the English label lands in the same shape", () => {
  assert.equal(
    sessionReferenceMarkdown(
      { id: "01a214bb-03a4-7532-9260-6ed08e100d5a", name: "Voice call review", firstMessage: "", path: `/home/me/.pi/agent/sessions/--p--/${FILE}` },
      enLabel,
    ),
    `[Reference session "Voice call review"](/home/me/.pi/agent/sessions/--p--/${FILE})`,
  );
});
