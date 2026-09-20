import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSelectionRecipe,
  buildTranscriptJsonSchema,
  buildTranscriptZodSchema,
  TRANSCRIPT_PROMPT,
  TRANSCRIPT_LIMITS,
  HEATMAP_SCHEMA_SHA256,
} from "./clip-selection-contract.mjs";
import { sha256Canonical } from "./canonical-json.mjs";

const base = {
  selectorId: "transcript-llm",
  providerId: "openai-api",
  desiredClipCount: 3,
};
const clip = {
  rank: 1,
  title: "A complete useful idea",
  ideaKey: "attention-switching",
  startCueId: "c000001",
  contextCueId: "c000002",
  insightCueId: "c000003",
  payoffCueId: "c000004",
  endCueId: "c000005",
  contextSummary: "Enough context for a new listener",
  insightSummary: "A substantive and nonobvious insight",
  payoffSummary: "A clear application of the insight",
  score: 0.94,
  editorialChecks: {
    selfContained: true,
    hasSetupBeforeClaim: true,
    completeThought: true,
    substantiveInsight: true,
    containsSponsorOrCta: false,
  },
};

test("recipe hashes include real prompt/schema and all behavior inputs", () => {
  const original = buildSelectionRecipe(base);
  assert.equal(
    original.recipe.prompt.sha256,
    sha256Canonical(TRANSCRIPT_PROMPT),
  );
  assert.equal(
    original.recipe.outputSchema.sha256,
    sha256Canonical(buildTranscriptJsonSchema(3)),
  );
  assert.equal(original.sha256, sha256Canonical(original.recipe));
  const variants = [
    { providerId: "chatgpt-oauth" },
    { model: "future-model" },
    { promptVersion: "v2" },
    { prompt: "new instructions" },
    { outputSchemaVersion: 2 },
    { outputSchema: { type: "object" } },
    { desiredClipCount: 4 },
    ...Object.keys(TRANSCRIPT_LIMITS).map((key) => ({
      limits: { ...TRANSCRIPT_LIMITS, [key]: TRANSCRIPT_LIMITS[key] + 1 },
    })),
  ];
  for (const variant of variants)
    assert.notEqual(
      buildSelectionRecipe({ ...base, ...variant }).sha256,
      original.sha256,
    );
  assert.notEqual(
    buildSelectionRecipe({
      ...base,
      providerId: "chatgpt-oauth",
      codexVersion: "next",
    }).sha256,
    buildSelectionRecipe({ ...base, providerId: "chatgpt-oauth" }).sha256,
  );
  assert.throws(() => {
    original.recipe.limits.minimumClipMs = 0;
  });
  for (const variant of [{ maxClips: 2 }, { minimumSeparationMs: 1 }])
    assert.notEqual(
      buildSelectionRecipe({ selectorId: "youtube-heatmap", ...variant })
        .sha256,
      buildSelectionRecipe({ selectorId: "youtube-heatmap" }).sha256,
    );
  assert.equal(
    buildSelectionRecipe({ selectorId: "youtube-heatmap" }).recipe.outputSchema
      .sha256,
    HEATMAP_SCHEMA_SHA256,
  );
});

test("real transcript schemas enforce exact output shape and normalized Unicode bounds", () => {
  const schema = buildTranscriptJsonSchema(3);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["clips"]);
  assert.equal(schema.properties.clips.minItems, 3);
  assert.equal(schema.properties.clips.maxItems, 3);
  assert.equal(schema.properties.clips.items.additionalProperties, false);
  const validator = buildTranscriptZodSchema(3);
  const valid = { clips: [clip, { ...clip, rank: 2 }, { ...clip, rank: 3 }] };
  assert.equal(validator.parse(valid).clips.length, 3);
  for (const change of [
    { title: "😀".repeat(11) },
    { title: "😀".repeat(81) },
    { score: NaN },
    { score: Infinity },
    { rank: 0 },
    { rank: 4 },
    { ideaKey: "bad_key" },
    { startCueId: "c1" },
    { extra: true },
    { editorialChecks: { ...clip.editorialChecks, selfContained: false } },
  ])
    assert.equal(
      validator.safeParse({ clips: [{ ...clip, ...change }, clip, clip] })
        .success,
      false,
    );
  assert.equal(
    validator.parse({
      clips: [
        { ...clip, title: "  " + "e\u0301".repeat(12) + "  " },
        clip,
        clip,
      ],
    }).clips[0].title,
    "é".repeat(12),
  );
  assert.equal(
    validator.parse({
      clips: [{ ...clip, title: "😀".repeat(80) }, clip, clip],
    }).clips[0].title,
    "😀".repeat(80),
  );
  assert.equal(validator.safeParse({ clips: [clip] }).success, false);
});
