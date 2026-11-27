import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { toCustomPanelInput } = await jiti.import("./extension-ui-payload.ts");

test("a one-shot probe pick travels as one JSON line", () => {
  assert.equal(
    toCustomPanelInput({ pick: "2", label: "轻条 · inline status message" }),
    '{"pick":"2","label":"轻条 · inline status message"}',
  );
});

test("a stepper page answers with its whole payload, and cancel is not an empty answer", () => {
  const answers = { answers: [{ stepIndex: 0, kind: "option", pick: "1", label: "顶部条" }] };
  assert.equal(toCustomPanelInput(answers), JSON.stringify(answers));
  assert.equal(toCustomPanelInput({ cancelled: true }), '{"cancelled":true}');
});

test("the host forwards whatever the extension authored, without knowing its schema", () => {
  const exotic = { choice: "b", note: "别弹窗" };
  assert.equal(toCustomPanelInput(exotic), JSON.stringify(exotic));
});

test("anything that is not a plain object keeps travelling as typed input, unsent", () => {
  for (const junk of [null, undefined, "", "typed text", "\x03", 7, [], {}, [{ pick: "1" }]]) {
    assert.equal(toCustomPanelInput(junk), null, `should refuse ${JSON.stringify(junk)}`);
  }
});
