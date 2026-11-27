# 0009 — Extension UI may carry HTML, and a host that ignores it still shows lines

## Status

Proposed. One optional field in one union plus one render branch. The extension that uses it lives in a separate repo (`pi-ask-user-plus`), and on an unpatched host it does what it does today: text.

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
- Two hosts run pi-web here with different code: the office machine runs the npm build (0.18.0), and this one runs the fork. The patch lands on the fork only, so the enhancement is visible in fork-served sessions first.
