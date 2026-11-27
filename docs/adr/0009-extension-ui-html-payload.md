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
