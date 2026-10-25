import assert from "node:assert/strict";
import test from "node:test";
import { buildTemplateListing } from "./template-listing.mjs";
import {
  listTemplates,
  resolveTemplateSelection,
} from "../../src/templates/catalog.mjs";

test("sample links match the exact template, version and variation", () => {
  const original = listTemplates()[0];
  const otherVersion = structuredClone(original);
  otherVersion.version = "2";
  const otherTemplate = structuredClone(original);
  otherTemplate.id = "other";
  const withVariation = structuredClone(original);
  withVariation.variations.push({ ...original.variations[0], id: "other" });
  const result = buildTemplateListing([withVariation, otherVersion, otherTemplate]);
  assert.deepEqual(result.templates[0].variations[0].preview, {
    status: "video-configured",
    pageUrl: "https://media.ferarana.work/templates/classic/v1/",
    posterUrl: "https://media.ferarana.work/templates/classic/v1/poster.jpg",
    videoUrl: "https://media.ferarana.work/templates/classic/v1/demo.mp4",
  });
  assert.equal(result.templates[0].variations[1].preview, undefined);
  assert.equal(result.templates[1].variations[0].preview, undefined);
  assert.equal(result.templates[2].variations[0].preview, undefined);
});

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
