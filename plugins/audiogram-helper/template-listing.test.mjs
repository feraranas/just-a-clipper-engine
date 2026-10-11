import assert from "node:assert/strict";
import test from "node:test";
import { buildTemplateListing } from "./template-listing.mjs";
import {
  listTemplates,
  resolveTemplateSelection,
} from "../../src/templates/catalog.mjs";

test("every advertised variation and default resolves through the creation catalog", () => {
  for (const t of buildTemplateListing().templates) {
    resolveTemplateSelection(t.defaultSelection);
    for (const v of t.variations)
      resolveTemplateSelection({
        templateId: t.templateId,
        templateVersion: t.templateVersion,
        variationId: v.variationId,
      });
  }
});
test("projection discovers an added catalog entry and excludes renderer details", () => {
  const entry = JSON.parse(JSON.stringify(listTemplates()[0]));
  entry.id = "fixture";
  entry.name = "Fixture";
  const result = buildTemplateListing([...listTemplates(), entry]);
  assert.equal(result.templates[1].templateId, "fixture");
  assert.equal(JSON.stringify(result).includes("compositionId"), false);
  assert.equal(JSON.stringify(result).includes("treatment"), false);
});
test("invalid metadata, duplicate identity, and unavailable defaults fail closed", () => {
  for (const change of [
    (e) => delete e.description,
    (e) => (e.defaultVariationId = "missing"),
    (e) => e.variations.push(e.variations[0]),
    (e) => delete e.variations[0].treatment,
  ]) {
    const entry = JSON.parse(JSON.stringify(listTemplates()[0]));
    change(entry);
    assert.throws(() => buildTemplateListing([entry]));
  }
  assert.throws(() =>
    buildTemplateListing([...listTemplates(), ...listTemplates()]),
  );
});
