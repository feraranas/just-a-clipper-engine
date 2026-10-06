import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveTemplateSelection,
  listTemplates,
  classicDefaults,
} from "../src/templates/catalog.mjs";
import { resolveTemplateSelectionConfig } from "./template-selection-config.mjs";
import { treatmentRegistry } from "./treatment-registry.mjs";
const selection = {
  templateId: "classic",
  templateVersion: "1",
  variationId: "default",
};
test("omitted and explicit selections identify the same existing render", () => {
  const resolved = resolveTemplateSelection();
  assert.deepEqual(resolved, {
    selection,
    treatment: { id: "audiogram-basic", version: "1" },
    compositionId: "AudiogramBasic",
    renderKey: "audiogram-basic@1",
  });
  assert.deepEqual(resolveTemplateSelection(selection), resolved);
  assert.equal(
    treatmentRegistry.get(resolved.treatment.id, resolved.treatment.version)
      .compositionId,
    resolved.compositionId,
  );
  assert.equal(listTemplates()[0].label, "Classic");
});
for (const input of [
  null,
  [],
  false,
  { templateId: "" },
  { variationId: null },
  { templateId: "missing" },
  { templateVersion: "2" },
  { variationId: "other" },
  { templateId: " classic" },
  { typo: "classic" },
]) {
  test(`rejects invalid selection ${JSON.stringify(input)}`, () =>
    assert.throws(() => resolveTemplateSelection(input), {
      code: "INVALID_TEMPLATE_SELECTION",
    }));
}
test("caller cannot mutate the next render choice or nested defaults", () => {
  const result = resolveTemplateSelection();
  result.selection.templateId = "changed";
  assert.equal(resolveTemplateSelection().selection.templateId, "classic");
  assert.throws(() => {
    classicDefaults.visualizer.color = "red";
  }, TypeError);
  assert.throws(() => {
    listTemplates()[0].variations[0].id = "changed";
  }, TypeError);
});
test("request fields override environment while omitted fields use configured values", () => {
  assert.deepEqual(
    resolveTemplateSelectionConfig({
      environment: {
        AUDIOGRAM_TEMPLATE: "classic",
        AUDIOGRAM_TEMPLATE_VERSION: "1",
        AUDIOGRAM_VARIATION: "default",
      },
    }),
    resolveTemplateSelection(),
  );
  assert.deepEqual(
    resolveTemplateSelectionConfig({
      request: selection,
      environment: { AUDIOGRAM_TEMPLATE: "bad", AUDIOGRAM_VARIATION: "bad" },
    }),
    resolveTemplateSelection(),
  );
  assert.throws(
    () =>
      resolveTemplateSelectionConfig({
        environment: { AUDIOGRAM_TEMPLATE: "" },
      }),
    { code: "INVALID_TEMPLATE_SELECTION" },
  );
  assert.throws(
    () => resolveTemplateSelectionConfig({ request: { templateId: null } }),
    { code: "INVALID_TEMPLATE_SELECTION" },
  );
});
