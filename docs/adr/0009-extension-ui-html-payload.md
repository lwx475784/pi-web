# 0009 — Extension UI may carry HTML, and a host that ignores it still shows lines

## Status

Accepted and implemented on the fork (`feat/extension-ui-html-payload`): the wire field, the panel, and the tests.

Verified on 2026-11-27 with a throwaway extension whose component carries `htmlPreview()`:

- Patched host (`next dev`, port 30142, opened from another machine over the tailnet): the panel drew the page
  at full size with a maximize toggle, `提交` ran each candidate's real timing, and one card click reached the
  extension as `{"pick":"2","label":"轻条 · inline status message"}` — the notify line came from the extension's
  own `done()`, so the hop `htmlPreview → iframe → postMessage → extension_ui_input → handleInput` is closed.
- Unpatched host (the running production build, same extension, same machine): the panel showed the component's
  ANSI lines, no error, no blank. That is the degradation half of this ADR, measured rather than assumed. One optional field in one union plus one render branch. The extension that uses it lives in a separate repo (`pi-ask-user-plus`), and on an unpatched host it does what it does today: text.

## Context

- An extension reaches this host as `extension_ui_request`. `custom` carries `lines: string[]`, `select` carries text options (`lib/types.ts:210-221`); `ExtensionCustomPanel` renders them through `normalizeCustomPanelLines()` and `stripAnsi()`.
- The recognition-first skill's second step shows three candidates that differ on one axis. Text cannot carry that judgement: the reader has to see the rendered thing — area, colour, motion — and then pick one. Each alternative was tried and measured:
  - FileViewer already previews `.html` in `<iframe sandbox="allow-scripts" srcDoc>`, but only inside the file panel: opened by hand, no zoom, and no way back into the session.
  - A native window (glimpse) appears only on the machine running pi. Someone reading the page from another device never sees it: 90 seconds, no click, `Prompt timed out`.
  - A Markdown image preview animates, but it cannot answer — the reply comes back typed, which is one more round and nothing gates it.
- `rpiv-ask-user-question` already blocks on this same channel, and it refuses an outside answer while an RPC host owns the prompts (`unsupported_host`). An out-of-band HTTP side-channel would therefore duplicate a decision the session already holds, and add a port, CORS, and an auth question.

## Decision

1. `ExtensionUiRequest` gains optional fields only: `custom` takes `html?: string` and `pick?: { id: string; label?: string }[]`; `select` takes `options[].preview_html?: string`. Nothing existing changes shape.
2. A host renders `html` in the panel it already owns, as `<iframe sandbox="allow-scripts" srcDoc>`. Opaque origin on purpose: no `allow-same-origin`, so no CORS, and the web password cookie never enters the frame.
3. The frame answers with `postMessage({ pick, label })`. The parent feeds that into the existing `onInput` / `extension_ui_input` path. No new route, no new port, no new auth surface.
4. Absent `html` behaves exactly as today, and a host that has never heard of `html` ignores it and shows `lines`. **Capability is signalled by silence**: an extension sends both and lets the host choose, so there is no version negotiation to keep correct.
5. `html` is trusted the way tool output is trusted, not the way a web page is: the script inside the frame is the extension's own, and without `allow-same-origin` it cannot reach the host's DOM or storage.
6. The panel reuses `hooks/useResizablePanel.ts` and gains a maximize toggle. Without a resizable, maximizable frame, three renderings are not actually comparable.

## Consequences

- About 40–60 lines plus a test: one optional field, one branch.
- Everything else belongs to the plugin: candidate pages, alias and term display, keyboard handling, the TUI renderer, and the degradation ladder.
- Whether upstream takes this is not decided here. The fork carries it first, and the plugin degrades to text on an unpatched host, so a slow upstream does not block the plugin.
- The panel reuses the keys `chat.extensionMaximize` / `chat.extensionRestoreSize` that another panel already had: no new strings in three locales.
- A component test that renders `ChatWindow` must stub `*.module.css` with `registerHooks`, the way `ChatMinimap.test.mjs` does; the frame's `sandbox="allow-scripts"` and the absence of `allow-same-origin` are asserted there, because a later edit that "just adds same-origin" would silently open the frame to the host DOM and its cookie.
- Two hosts run pi-web here with different code: the office machine runs the npm build (0.18.0), and this one runs the fork. The patch lands on the fork only, so the enhancement is visible in fork-served sessions first.

## Open issues

The fork keeps GitHub issues off, so the checklist lives here, as the voice ADR does.

- [x] `lib/types.ts`: `custom` takes `html?: string` and `pick?: { id; label? }[]`; `select` takes
      `html` comes from a `htmlPreview()` method on the component. Optional only — no existing shape changes.
- [x] `ExtensionCustomPanel` in `components/ChatWindow.tsx`: with `html`, render
      `<iframe sandbox="allow-scripts" srcDoc={html}>` in place of the ANSI output.
- [x] `postMessage({ pick, label })` from the frame into the existing `onInput` / `extension_ui_input` path.
- [x] Reuse `hooks/useResizablePanel.ts` and add a maximize toggle, with the i18n label in en / zh-CN / zh-TW.
- [x] Tests: no `html` renders as today; with `html` the frame answers once on `pick`; an SSE reconnect
      replays a pending `html` request the way the queue already replays others (the queue is untouched, so the
      replay path is inherited; a component test stubs `*.module.css` the way `ChatMinimap.test.mjs` does).
- [x] Out of scope here: the extension itself (`lwx475784/pi-ask-user-plus`), the TUI renderer, any HTTP
      side-channel, and version negotiation.

## Follow-up · 上游 0.19.0 合进这条分支（2026-11-28，合并提交 `25582352`）

上游领先这条分支 37 个提交（v0.19.0 + 2）。合完在 worktree 里量，不在生产上试：

- **合并本身零冲突**（先用 `git merge-tree` 三方预演说过零，真合并与它一致）。分支只碰 8 个文件，
  其中 3 个（`components/ChatWindow.tsx`、`lib/rpc-manager.ts`、`lib/types.ts`）上游也改过，
  但改的不是同一处。
- 宿主全量 **3836 条，10 红**；同一份 node_modules 下把 worktree 切到**纯净 `origin/main`** 再跑，
  红的是**同样那 10 条**。它们是本机的环境，不是合并：`lib/subagent-package-scope.integration.test.mjs`
  9 条断言的是精确的技能/工具清单，而 mm 装了 ~40 个用户级技能；另 1 条 `.npmrc` 单独跑就绿。
  记在这儿是为了下一位不去追这 10 条。
- `tsc --noEmit` 0 错；`next build --webpack` 过。
- 候选页对合并后的构建（临时实例 30145，不在 30141 上）**12/12、0 跳过**。

三个上游提交落在这份 ADR 的表面上，现在都是量过的而不是推的：

- `23f318cd` 把 `frame-ancestors` 默认收到 Pi Web 自己的源。面板是 `srcDoc` 帧：没有导航、没有响应，
  这条策略管不到它 —— 上面 12 条就是证据，不是推理。
- `ea36a8f9` 把 pi 升到 1.6.1。`custom` 与 `pasteToEditor` / `setEditorText` 形状没变，
  所以扩展那边只认 `PI_WEB_UI_HTML` 这个标记（capability-by-silence）仍然说它原本说的话。
- `daf24fff` + `bf81275e` + `bad7ef35` 把 `#` 在输入框引用其他会话落到 `lib/session-reference.ts`
  （`[title](#session:<id>)`，发送时在服务端展开成带 bounded transcript 的 `<session-reference>` 块）。
  fork 自建的行菜单引用（`feature/voice-input` 里同名但不同物的 94 行 `lib/session-reference.ts`）
  从此就是重复的那一份：第二跳吃上游的，删 fork 的。上游的 `session.copyId` 是**会话信息面板**的复制按钮，
  **行菜单**上的复制 ID 上游没有。

语音入口还差一个宿主属性，记在这儿但不在这个 ADR 里做：面板的 iframe 是 `sandbox="allow-scripts"`，
没有 `allow="microphone"`，而且它只在一次扩展 UI 请求期间存在。所以扩展能搬走转写这一半
（工具 + `pasteToEditor` + 这个面板），搬不走浏览器那一半的麦克风。
