import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { toCustomPanelPickPayload } = await jiti.import("./extension-ui-payload.ts");

test("a click inside the frame becomes one JSON answer", async () => {
  assert.equal(
    toCustomPanelPickPayload({ pick: "2", label: "轻条 · inline status message" }),
    '{"pick":"2","label":"轻条 · inline status message"}',
  );
  assert.equal(toCustomPanelPickPayload({ pick: "1" }), '{"pick":"1"}');
});

test("everything that is not a pick keeps travelling as before", async () => {
  for (const junk of [null, undefined, "typed text", "\x03", 7, { label: "no pick" }, { pick: "" }, { pick: 3 }]) {
    assert.equal(toCustomPanelPickPayload(junk), null, `should ignore ${JSON.stringify(junk)}`);
  }
});
