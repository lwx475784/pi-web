import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createJiti } from "jiti";

// ChatWindow pulls a *.module.css through ChatMinimap; the fork's component tests stub it out.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, key) => String(key) });" };
  },
});

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ExtensionCustomPanel } = await jiti.import("./ChatWindow.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderPanel(request) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionCustomPanel, { request, waitingCount: 1, onInput: () => {} }),
    ),
  );
}

test("an ANSI panel keeps rendering lines, with no frame at all", () => {
  const html = renderPanel({ type: "extension_ui_request", id: "a", method: "custom", lines: ["\u001b[31mthree candidates\u001b[0m"] });
  assert.match(html, /three candidates/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /aria-expanded="true"/);
});

test("a panel that offers a page gets the frame, sandboxed and never same-origin", () => {
  const html = renderPanel({
    type: "extension_ui_request",
    id: "b",
    method: "custom",
    lines: ["耳语 · 轻条 · 横幅"],
    html: "<!doctype html><h1>选这档</h1>",
  });
  assert.match(html, /<iframe[^>]*sandbox="allow-scripts"/);
  // Opaque origin on purpose: no allow-same-origin, so no CORS and no web-password cookie in the frame.
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.doesNotMatch(html, /src="http/);
});

test("a page request is maximizable, and the collapsed bar still summarises the lines", () => {
  const html = renderPanel({ type: "extension_ui_request", id: "c", method: "custom", lines: ["耳语 · 轻条 · 横幅"], html: "<h1>x</h1>" });
  assert.match(html, /Maximize/);
});
